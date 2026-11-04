import { Dialog } from "@foldkit/ui"
import { Redacted } from "effect"
import * as v from "valibot"
import { describe, expect, test } from "vite-plus/test"
import { init, Message, update } from "../src/preview/main.ts"
import { FrameReply, ParentMessage } from "../src/preview/protocol.ts"

describe("preview dialog", () => {
  test("opening retains private input without exposing the name in diagnostics", () => {
    const input = Redacted.make({ file: new Blob(["private contents"]), name: "private-name.txt" })
    const message = Message.RequestedOpen({ input })
    const result = update(init().model, message)
    expect(result.model.dialog.isOpen).toBe(true)
    expect(Redacted.value(result.model.input)?.name).toBe("private-name.txt")
    expect(JSON.stringify([message, result.model, result.commands])).not.toContain("private-name.txt")
  })

  test("a new request ignores replies from an older frame", () => {
    const first = update(init().model, Message.RequestedOpen({ input: Redacted.make({ file: new Blob(["one"]), name: "one.txt" }) })).model
    const second = update(first, Message.RequestedOpen({ input: Redacted.make({ file: new Blob(["two"]), name: "two.txt" }) })).model
    const stale = update(second, Message.ChangedStatus({ generation: first.generation, status: "old", shown: true }))
    expect(stale.model).toBe(second)
    expect(stale.model.shown).toBe(false)
  })

  test("closing releases private input and invalidates late replies", () => {
    const opened = update(init().model, Message.RequestedOpen({ input: Redacted.make({ file: new Blob(["file"]), name: "name.txt" }) })).model
    const closed = update(opened, Message.GotDialogMessage({ message: Dialog.Message.RequestedClose() })).model
    expect(Redacted.value(closed.input)).toBeUndefined()
    expect(closed.generation).toBeGreaterThan(opened.generation)
    expect(update(closed, Message.ChangedStatus({ generation: opened.generation, status: "late", shown: true })).model.shown).toBe(false)
  })

  test("the frame channel accepts only supported messages and Blob content", () => {
    expect(v.safeParse(ParentMessage, { type: "show", kind: "text", blob: new Blob(["text"]) }).success).toBe(true)
    expect(v.safeParse(ParentMessage, { type: "show", kind: "html", blob: new Blob(["text"]) }).success).toBe(false)
    expect(v.safeParse(ParentMessage, { type: "show", kind: "text", blob: "text" }).success).toBe(false)
    expect(v.safeParse(FrameReply, { type: "unexpected" }).success).toBe(false)
  })
})
