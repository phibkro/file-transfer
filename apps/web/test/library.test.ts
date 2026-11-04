import { Predicate, Redacted } from "effect"
import { describe, expect, test } from "vite-plus/test"
import { FileDrop, Tabs } from "@foldkit/ui"
import { boot, cancel, init, Message, update } from "../src/library/main.ts"

const firstFile = { identifier: 7, revision: 3, name: "first-private.txt", size: 4, lastModified: 10, fingerprint: "first" }
const secondFile = { identifier: 8, revision: 9, name: "second-private.txt", size: 5, lastModified: 20, fingerprint: "second" }
const collection = { identifier: 3, revision: 6, name: "Private collection", fileIdentifiers: [7, 8] }

const catalogModel = () => ({
  ...init().model,
  snapshot: Redacted.make({ enabled: true, epoch: 12, files: [firstFile, secondFile], collections: [collection] }),
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
      expect(result.model.busy).toBe(false)
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
    const message = Message.GotFileDropMessage({
      message: Redacted.make(FileDrop.Message.DroppedFiles({ files: [new File(["private"], "private-fixture.txt")] })),
    })

    const next = update(init().model, message)
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
    expect(next.model.busy).toBe(true)
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
    expect(failed.model.busy).toBe(false)
    expect(update(failed.model, Message.RequestedReload()).commands).toHaveLength(1)
  })
})
