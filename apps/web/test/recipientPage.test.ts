import { Redacted } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { boot, init, Message, update } from "../src/features/receive/main.ts"
import type { RecipientSnapshot } from "../src/features/receive/session.ts"
import * as Name from "../src/ui/name.ts"

const offer: RecipientSnapshot = {
  phase: "Reviewing",
  status: "reviewing",
  statusText: "Review files",
  files: [{ name: "private.txt", size: 100 }],
  totalBytes: 100,
  mobileWarning: false,
  spaceShortfall: undefined,
  spaceChecking: false,
  progress: { done: 0, total: 0 },
  filesRemoved: false,
  unsavedFiles: false,
  failure: undefined,
  failureDetail: undefined,
  path: "relay",
  summary: { bytes: 100, seconds: 0, reconnects: 0, direct: false, secondsToDirect: undefined, directDrops: 0 },
}

const modelFor = (snapshot: RecipientSnapshot) => update(init().model, Message.ReceivedSnapshot({ snapshot: Redacted.make(snapshot) })).model

describe("recipient page", () => {
  it("only accepts after quota checking and while reviewing", () => {
    expect(update(modelFor(offer), Message.RequestedAccept()).commands).toHaveLength(1)
    expect(update(modelFor({ ...offer, spaceChecking: true }), Message.RequestedAccept()).commands).toBeUndefined()
    expect(update(modelFor({ ...offer, spaceShortfall: 1 }), Message.RequestedAccept()).commands).toBeUndefined()
    expect(update(modelFor({ ...offer, phase: "Failed" }), Message.RequestedAccept()).commands).toBeUndefined()
    expect(update(modelFor({ ...offer, phase: "Failed" }), Message.RequestedDecline()).commands).toBeUndefined()
  })

  it("routes name messages by the retained file identity and drops unknown identities", () => {
    const model = modelFor(offer)
    const id = model.names[0]?.identifier ?? ""
    const started = update(model, Message.GotNameMessage({ id, message: Redacted.make(Name.Message.Started()) })).model
    expect(started.names[0]?.editing).toBe(true)
    const stale = update(started, Message.GotNameMessage({ id: "missing", message: Redacted.make(Name.Message.Cancelled()) })).model
    expect(stale.names[0]?.editing).toBe(true)
  })

  it("keeps received names and link fragments private in preserved state", () => {
    expect(JSON.stringify(boot("room", Redacted.make("fragment-secret")).model)).not.toContain("fragment-secret")
    const model = modelFor(offer)
    expect(JSON.stringify(model)).not.toContain("private.txt")
  })
})
