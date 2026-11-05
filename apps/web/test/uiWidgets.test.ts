import { Option, Redacted } from "effect"
import { describe, expect, it } from "vite-plus/test"
import * as Name from "../src/ui/name.ts"
import * as Settings from "../src/features/settings/main.ts"
import * as Share from "../src/ui/share.ts"

describe("private transfer widgets", () => {
  it("validates collisions and emits the normalized private name", () => {
    const context: Name.Context = { name: Redacted.make("one.txt"), names: ["one.txt", "two.txt"], index: 0, canRename: true }
    const started = Name.update(Name.init("name-1"), Name.Message.Started(), context).model
    const duplicate = Name.update(started, Name.Message.Changed({ name: Redacted.make("two.txt") }), context).model
    const rejected = Name.update(duplicate, Name.Message.Saved(), context)
    expect(Option.isSome(rejected.model.problem)).toBe(true)
    expect(rejected.outMessage).toBeUndefined()
    const changed = Name.update(rejected.model, Name.Message.Changed({ name: Redacted.make("  three.txt  ") }), context).model
    const saved = Name.update(changed, Name.Message.Saved(), context)
    expect(saved.outMessage?._tag).toBe("Renamed")

    if (saved.outMessage?._tag === "Renamed") {
      expect(Redacted.value(saved.outMessage.name)).toBe("three.txt")
    }

    expect(saved.model.editing).toBe(false)
  })

  it("keeps QR generation lazy and ignores results for a replaced link", () => {
    const first = Redacted.make("https://example.test/r/one#secret")
    const second = Redacted.make("https://example.test/r/two#other")
    const initial = Share.boot(first).model
    expect(Option.isNone(initial.qr)).toBe(true)
    const shown = Share.update(initial, Share.Message.ToggledQr({ open: true }))
    expect(shown.commands).toHaveLength(1)
    const replacement = Share.boot(second).model
    const stale = Share.update(replacement, Share.Message.GeneratedQr({ link: first, qr: Redacted.make({ size: 1, path: "private" }) }))
    expect(Option.isNone(stale.model.qr)).toBe(true)
  })

  it("does not race a new direct preference against stale settings reads", () => {
    const use = { receivedBytes: 0, inUse: 0, stale: 0, usage: undefined, quota: undefined, removable: false }
    const loaded = Settings.update(Settings.init().model, Settings.Message.Loaded({ use, direct: true })).model
    const changed = Settings.update(loaded, Settings.Message.ToggledDirect({ allowed: false }))
    expect(changed.commands).toHaveLength(1)
    const stale = Settings.update(changed.model, Settings.Message.Loaded({ use, direct: true })).model
    expect(stale.direct).toBe(false)
    expect(Settings.update(stale, Settings.Message.ToggledDirect({ allowed: true })).commands).toBeUndefined()
  })

  it("loads appearance independently and serializes preference changes", () => {
    const initial = Settings.init().model
    expect(initial.appearance).toBe("system")
    expect(Settings.update(initial, Settings.Message.SelectedAppearance({ appearance: "dark" })).commands).toBeUndefined()
    const loaded = Settings.update(initial, Settings.Message.LoadedAppearance({ appearance: "light" })).model
    const changed = Settings.update(loaded, Settings.Message.SelectedAppearance({ appearance: "dark" }))
    expect(changed.model.appearance).toBe("dark")
    expect(changed.commands).toHaveLength(1)
    expect(Settings.update(changed.model, Settings.Message.SelectedAppearance({ appearance: "system" })).commands).toBeUndefined()
    const saved = Settings.update(changed.model, Settings.Message.SavedAppearance()).model
    expect(Settings.update(saved, Settings.Message.SelectedAppearance({ appearance: "system" })).commands).toHaveLength(1)
  })
})
