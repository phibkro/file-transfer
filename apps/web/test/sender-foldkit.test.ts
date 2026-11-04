import { Option, Redacted } from "effect"
import { FileDrop } from "@foldkit/ui"
import { describe, expect, it } from "vite-plus/test"
import * as Sender from "../src/sender/main.ts"
import * as Name from "../src/ui/name.ts"

describe("Quick Share Library handoff", () => {
  it("does not auto-seal a selection with a colliding name", () => {
    const files = [new File(["one"], "one.txt"), new File(["two"], "ONE.txt")]
    const booted = Sender.boot({ files: Redacted.make(files), autoSeal: true })
    expect(Redacted.value(booted.model.entries)).toHaveLength(1)
    expect(Redacted.value(booted.model.rejections)).toHaveLength(1)
    const loaded = Sender.update(booted.model, Sender.Message.LoadedLimits({ limits: Option.none() }))
    expect(loaded.model.sealed).toBe(false)
    expect(loaded.model.active).toBe(false)
  })

  it("waits for limits before auto-sealing an accepted selection", () => {
    const booted = Sender.boot({ files: Redacted.make([new File(["one"], "one.txt")]), autoSeal: true })
    expect(booted.model.sealed).toBe(false)
    const loaded = Sender.update(booted.model, Sender.Message.LoadedLimits({ limits: Option.none() }))
    expect(loaded.model.sealed).toBe(true)
    expect(loaded.model.active).toBe(true)
  })

  it("does not auto-seal a selection above the server limit", () => {
    const booted = Sender.boot({ files: Redacted.make([new File(["one"], "one.txt")]), autoSeal: true })
    const loaded = Sender.update(booted.model, Sender.Message.LoadedLimits({ limits: Option.some({ relayedBytesPerRoom: 1, roomsPerAddressPerHour: 1 }) }))
    expect(loaded.model.sealed).toBe(false)
    expect(loaded.model.active).toBe(false)
  })
  it("ignores a link queued after cancellation", () => {
    const booted = Sender.boot({ files: Redacted.make([new File(["one"], "one.txt")]), autoSeal: true })
    const started = Sender.update(booted.model, Sender.Message.LoadedLimits({ limits: Option.none() })).model
    const cancelled = Sender.update(started, Sender.Message.RequestedCancel()).model
    const late = Sender.update(cancelled, Sender.Message.ReceivedLink({ link: Redacted.make("https://example.test/r/id#secret") })).model
    expect(late.hasLink).toBe(false)
    expect(Redacted.value(late.status)).toBe("Transfer cancelled.")
  })

  it("keeps filenames and links out of diagnostic serialization", () => {
    const booted = Sender.boot({ files: Redacted.make([new File(["content"], "private-fixture.txt")]), autoSeal: false })
    expect(JSON.stringify(booted.model)).not.toContain("private-fixture.txt")
    const message = Sender.Message.ReceivedLink({ link: Redacted.make("https://example.test/r/id#private-secret") })
    expect(JSON.stringify(message)).not.toContain("private-secret")
  })
  it("appends file batches without silently losing earlier collisions", () => {
    const first = Sender.boot({ files: Redacted.make([new File(["one"], "one.txt"), new File(["duplicate"], "ONE.txt")]), autoSeal: false }).model

    const next = Sender.update(
      first,
      Sender.Message.ReceivedPrivateFileDropMessage({ message: Redacted.make(FileDrop.Message.DroppedFiles({ files: [new File(["two"], "two.txt")] })) }),
    ).model

    expect(Redacted.value(next.entries).map((entry) => entry.name)).toEqual(["one.txt", "two.txt"])
    expect(Redacted.value(next.rejections)).toHaveLength(1)
    expect(Sender.update(next, Sender.Message.DismissedRejections()).model.rejections).toEqual(Redacted.make([]))
  })
  it("renames before sealing but rejects a collision", () => {
    let { model } = Sender.boot({ files: Redacted.make([new File(["one"], "one.txt"), new File(["two"], "two.txt")]), autoSeal: false })
    const key = Redacted.value(model.entries)[0]?.key ?? -1

    const send = (message: Name.Message) => {
      model = Sender.update(model, Sender.Message.ReceivedPrivateNameMessage({ key, message: Redacted.make(message) })).model
    }

    send(Name.Message.Started())
    send(Name.Message.Changed({ name: Redacted.make("two.txt") }))
    send(Name.Message.Saved())
    expect(Redacted.value(model.entries)[0]?.name).toBe("one.txt")
    send(Name.Message.Changed({ name: Redacted.make("renamed.txt") }))
    send(Name.Message.Saved())
    expect(Redacted.value(model.entries)[0]?.name).toBe("renamed.txt")
  })
})
