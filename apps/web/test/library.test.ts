import { deriveMyFiles } from "@file-transfer/catalog"
import type { LibraryCollection, LibrarySnapshot } from "@file-transfer/catalog"
import { Predicate, Redacted } from "effect"
import { describe, expect, test } from "vite-plus/test"
import { Dialog, FileDrop, Tabs } from "@foldkit/ui"
import { boot, cancel, init, Message, update } from "../src/features/library/main.ts"

const firstFile: LibrarySnapshot["files"][number] = { identifier: 7, revision: 3, name: "first-private.txt", size: 4, lastModified: 10, fingerprint: "first" }

const secondFile: LibrarySnapshot["files"][number] = {
  identifier: 8,
  revision: 9,
  name: "second-private.txt",
  size: 5,
  lastModified: 20,
  fingerprint: "second",
}

const collection: LibraryCollection = { identifier: 3, revision: 6, name: "Private collection", fileIdentifiers: [7, 8] }

const catalogModel = () => ({
  ...init().model,
  snapshot: Redacted.make<LibrarySnapshot>({ enabled: true, epoch: 12, files: [firstFile, secondFile], collections: [collection] }),
  collection: collection.identifier,
  selected: [firstFile.identifier, secondFile.identifier],
})

const actionFrom = (result: ReturnType<typeof update>) => {
  const command = result.commands?.find((entry) => entry.name === "RunLibraryAction")
  expect(command).toBeDefined()

  const args: unknown = command?.args

  expect(JSON.stringify(args)).not.toContain("first-private.txt")
  expect(JSON.stringify(args)).not.toContain("Private collection")

  return Predicate.hasProperty(args, "action") && Redacted.isRedacted(args.action) ? Redacted.value(args.action) : undefined
}

describe("Library page transitions", () => {
  test("preview resolves one current file without approving or sharing it", () => {
    const model = catalogModel()
    const requested = update(model, Message.RequestedPreview({ identifier: firstFile.identifier }))
    expect(requested.model.operation).toBe("preview")

    const file = new File(["current"], "current.txt")

    const opened = update(
      requested.model,
      Message.SucceededLibraryAction({
        generation: requested.model.generation,
        result: Redacted.make({ kind: "preview", file, identifier: firstFile.identifier }),
      }),
    )

    expect(opened.model.preview.dialog.isOpen).toBe(true)
    expect(opened.model.snapshot).toBe(model.snapshot)
    expect(opened.outMessage).toBeUndefined()
  })

  test("cancelled preview cannot open from a late result", () => {
    const requested = update(catalogModel(), Message.RequestedPreview({ identifier: firstFile.identifier })).model
    const cancelled = update(requested, Message.CancelledPreview())
    expect(cancelled.model.operation).toBe("cancelling")

    const file = new File(["current"], "current.txt")

    const late = update(
      cancelled.model,
      Message.SucceededLibraryAction({ generation: requested.generation, result: Redacted.make({ kind: "preview", file, identifier: firstFile.identifier }) }),
    )

    expect(Redacted.value(late.model.preview.input)).toBeUndefined()
    expect(late.outMessage).toBeUndefined()
  })

  test("My files review derives all portable entries without browser source objects", () => {
    const model = { ...catalogModel(), collection: 0, selected: [] }

    expect(actionFrom(update(model, Message.RequestedReviewCollection()))).toEqual({
      kind: "review",
      entries: [firstFile, secondFile],
      collection: deriveMyFiles(Redacted.value(model.snapshot)),
      epoch: 12,
    })
    expect(Redacted.value(model.snapshot).files).toEqual([firstFile, secondFile])
  })

  test("named collection review retains portable membership and revision", () => {
    const model = catalogModel()

    expect(actionFrom(update(model, Message.RequestedReviewCollection()))).toEqual({
      kind: "review",
      entries: [firstFile, secondFile],
      collection,
      epoch: 12,
    })
  })
  test("private search preserves selection and the complete collection review", () => {
    const model = catalogModel()
    const message = Message.ChangedSearch({ search: Redacted.make("first-private") })
    const searched = update(model, message).model
    expect(JSON.stringify(message)).not.toContain("first-private")
    expect(searched.selected).toEqual(model.selected)
    expect(actionFrom(update(searched, Message.RequestedReviewCollection()))).toEqual({
      kind: "review",
      entries: [firstFile, secondFile],
      collection,
      epoch: 12,
    })
  })
  test("selected subset of a named collection does not claim full membership", () => {
    const model = { ...catalogModel(), selected: [firstFile.identifier] }
    expect(actionFrom(update(model, Message.RequestedReview()))).toEqual({ kind: "review", entries: [firstFile], collection: undefined, epoch: 12 })
  })

  test("row sharing reviews exactly that file without changing selection", () => {
    const model = catalogModel()
    const result = update(model, Message.RequestedReviewFile({ identifier: firstFile.identifier }))
    expect(result.model.selected).toEqual(model.selected)
    expect(result.outMessage).toBeUndefined()
    expect(actionFrom(result)).toEqual({ kind: "review", entries: [firstFile], collection: undefined, epoch: 12 })
    expect(update(model, Message.RequestedReviewFile({ identifier: 99 })).commands).toBeUndefined()
  })

  test("closing the add dialog interrupts a picker and rejects stale results after reopening", () => {
    const opened = update(catalogModel(), Message.RequestedAddDialog()).model
    const pending = update(opened, Message.RequestedDurablePicker()).model
    const closed = update(pending, Message.GotDialogMessage({ message: Dialog.Message.RequestedClose() }))
    expect(closed.model.operation).toBe("cancelling")
    expect(closed.commands?.map((command) => command.name)).toContain("RunLibraryAction.Interrupt")
    expect(update(closed.model, Message.RequestedReload()).commands).toBeUndefined()
    const acknowledged = update(closed.model, Message.CompletedCancelRunLibraryAction()).model
    const reopened = update(acknowledged, Message.RequestedAddDialog()).model

    const stale = update(
      reopened,
      Message.SucceededLibraryAction({
        generation: pending.generation,
        result: Redacted.make({ kind: "snapshot", snapshot: { enabled: true, epoch: 13, files: [], collections: [] } }),
      }),
    )

    expect(stale.model).toBe(reopened)

    const lateDrop = Message.GotFileDropMessage({
      generationId: opened.dropGeneration,
      message: Redacted.make(FileDrop.Message.DroppedFiles({ files: [new File(["private"], "late-private.txt")] })),
    })

    expect(JSON.stringify(lateDrop)).not.toContain("late-private.txt")
    expect(update(reopened, lateDrop).commands).toBeUndefined()
    expect(update(reopened, Message.RequestedDurablePicker()).model.operation).toBe("source")
  })
  test("closing during file indexing blocks admission until interrupt acknowledgement", () => {
    const opened = update(catalogModel(), Message.RequestedAddDialog()).model

    const dropped = Message.GotFileDropMessage({
      generationId: opened.dropGeneration,
      message: Redacted.make(FileDrop.Message.DroppedFiles({ files: [new File(["data"], "original.txt")] })),
    })

    const pending = update(opened, dropped).model
    expect(pending.operation).toBe("source")
    const closed = update(pending, Message.GotDialogMessage({ message: Dialog.Message.RequestedClose() }))
    expect(closed.model.operation).toBe("cancelling")
    expect(closed.commands?.map((command) => command.name)).toContain("RunLibraryAction.Interrupt")
    expect(update(closed.model, Message.RequestedReload()).commands).toBeUndefined()

    const stale = update(
      closed.model,
      Message.SucceededLibraryAction({
        generation: pending.generation,
        result: Redacted.make({ kind: "snapshot", snapshot: Redacted.value(pending.snapshot) }),
      }),
    )

    expect(stale.model).toBe(closed.model)
    const acknowledged = update(closed.model, Message.CompletedCancelRunLibraryAction()).model
    expect(acknowledged.operation).toBe("idle")
    expect(update(acknowledged, Message.RequestedReload()).commands).toHaveLength(1)
  })

  test("membership commands carry the collection and every selected file revision privately", () => {
    const model = catalogModel()
    expect(actionFrom(update(model, Message.RequestedAddMembers({ identifier: collection.identifier })))).toEqual({
      kind: "add",
      collection,
      files: [firstFile, secondFile],
      epoch: 12,
    })
    expect(actionFrom(update(model, Message.RequestedRemoveMember({ identifier: secondFile.identifier })))).toEqual({
      kind: "remove",
      collection,
      file: secondFile,
      epoch: 12,
    })
  })

  test("confirmation retains the original file and collection snapshots and epoch", () => {
    const model = catalogModel()
    const fileDialog = update(model, Message.RequestedForgetFile({ identifier: firstFile.identifier })).model
    const collectionDialog = update(model, Message.RequestedForgetCollection()).model

    const newerSnapshot = Redacted.make({
      enabled: true,
      epoch: 13,
      files: [{ ...firstFile, revision: 4 }, secondFile],
      collections: [{ ...collection, revision: 7 }],
    })

    expect(actionFrom(update({ ...fileDialog, snapshot: newerSnapshot }, Message.ConfirmedAction()))).toEqual({
      kind: "forgetFile",
      file: firstFile,
      epoch: 12,
    })
    expect(actionFrom(update({ ...collectionDialog, snapshot: newerSnapshot }, Message.ConfirmedAction()))).toEqual({
      kind: "forgetCollection",
      collection,
      epoch: 12,
    })
  })

  test("missing selected files or collections reject operations instead of dropping entities", () => {
    const model = catalogModel()
    const missingFile = { ...model, selected: [firstFile.identifier, 99] }
    const missingCollection = { ...model, collection: 99 }

    const rejected = [
      update(missingFile, Message.RequestedAddMembers({ identifier: collection.identifier })),
      update(model, Message.RequestedAddMembers({ identifier: 99 })),
      update(model, Message.RequestedRemoveMember({ identifier: 99 })),
      update(missingCollection, Message.RequestedRemoveMember({ identifier: firstFile.identifier })),
      update(missingFile, Message.RequestedReview()),
    ]

    for (const result of rejected) {
      expect(result.commands ?? []).toEqual([])
      expect(result.model.operation).toBe("idle")
      expect(result.model.status).not.toBe(model.status)
    }
  })

  test("consent commands retain the epoch seen when requested", () => {
    const enabled = catalogModel()
    const disableDialog = update(enabled, Message.RequestedDisable()).model
    const changed = { ...disableDialog, snapshot: Redacted.make({ ...Redacted.value(enabled.snapshot), epoch: 15 }) }

    expect(actionFrom(update(changed, Message.ConfirmedAction()))).toEqual({ kind: "configure", enabled: false, epoch: 12 })
    expect(actionFrom(update(init().model, Message.RequestedEnable()))).toEqual({ kind: "configure", enabled: true, epoch: 0 })
  })

  test("consent is explicit and repeated clicks cannot admit concurrent edits", () => {
    const started = update(init().model, Message.RequestedEnable())
    expect(started.commands).toHaveLength(1)
    expect(Redacted.value(started.model.snapshot).enabled).toBe(false)
    expect(update(started.model, Message.RequestedEnable()).commands).toBeUndefined()
  })

  test("file selection cannot begin indexing before explicit consent", () => {
    const opened = update(init().model, Message.RequestedAddDialog()).model

    const message = Message.GotFileDropMessage({
      generationId: opened.dropGeneration,
      message: Redacted.make(FileDrop.Message.DroppedFiles({ files: [new File(["private"], "private-fixture.txt")] })),
    })

    const next = update(opened, message)
    expect(next.commands ?? []).toEqual([])
    expect(Redacted.value(next.model.snapshot).files).toEqual([])
    expect(JSON.stringify(message)).not.toContain("private-fixture.txt")
  })

  test("empty named collections require no selected files", () => {
    const clean = init().model
    const model = { ...clean, snapshot: Redacted.make({ ...Redacted.value(clean.snapshot), enabled: true }), name: Redacted.make("Private collection") }
    const next = update(model, Message.RequestedCreateCollection())
    expect(next.commands).toHaveLength(1)
    expect(next.model.selected).toEqual([])
    expect(JSON.stringify(next.commands?.[0]?.args)).not.toContain("Private collection")
  })

  test("selection toggles and changing collection clears selection", () => {
    const selected = update(init().model, Message.ToggledFile({ identifier: 7 })).model
    expect(selected.selected).toEqual([7])
    expect(update(selected, Message.ToggledFile({ identifier: 7 })).model.selected).toEqual([])
    expect(update(selected, Message.SelectedCollection({ identifier: 3 })).model.selected).toEqual([])
  })

  test("default collection cannot be forgotten and no selection cannot be shared", () => {
    expect(update(init().model, Message.RequestedForgetCollection()).commands).toBeUndefined()
    expect(update(init().model, Message.RequestedReview()).outMessage).toBeUndefined()
  })

  test("switches the visible storage location while idle", () => {
    const next = update(init().model, Message.GotTabsMessage({ message: Tabs.Message.SelectedTab({ index: 1, value: "cloud" }) }))
    expect(next.model.storageLocation).toBe("cloud")
  })

  test("does not switch storage panels while an operation owns the selection", () => {
    const pending = boot().model
    const next = update(pending, Message.GotTabsMessage({ message: Tabs.Message.SelectedTab({ index: 1, value: "cloud" }) }))
    expect(next.model.storageLocation).toBe("device")
    expect(next.model.operation).toBe("catalog")
    expect(next.model.generation).toBe(pending.generation)
  })

  test("departure invalidates queued results and addresses interruption", () => {
    const pending = boot().model
    const stopped = cancel(pending)
    expect(stopped.commands?.map((command) => command.name)).toEqual(["RunLibraryAction.Interrupt"])
    expect(stopped.model.generation).toBeGreaterThan(pending.generation)

    const stale = update(
      stopped.model,
      Message.SucceededLibraryAction({
        generation: pending.generation,
        result: Redacted.make({ kind: "snapshot", snapshot: { enabled: true, epoch: 1, files: [], collections: [] } }),
      }),
    )

    expect(stale.model).toBe(stopped.model)
    expect(stale.outMessage).toBeUndefined()
  })

  test("expected failure leaves operation admission usable", () => {
    const pending = boot().model
    const failed = update(pending, Message.FailedLibraryAction({ generation: pending.generation }))
    expect(failed.model.operation).toBe("idle")
    expect(update(failed.model, Message.RequestedReload()).commands).toHaveLength(1)
  })
})
