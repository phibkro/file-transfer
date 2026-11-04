import { Redacted } from "effect"
import { describe, expect, test } from "vite-plus/test"
import { FileDrop, Tabs } from "@foldkit/ui"
import { boot, cancel, init, Message, update } from "../src/library/main.ts"

describe("Library page transitions", () => {
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
