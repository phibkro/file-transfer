import { Option, Redacted } from "effect"
import { describe, expect, it } from "vite-plus/test"
import * as Main from "../src/app/main.ts"
import * as Library from "../src/features/library/main.ts"
import * as Sender from "../src/features/quick-share/main.ts"
import { AppRoute } from "../src/app/routes.ts"

const boot = () => Main.init({ route: AppRoute.QuickShare(), fragment: Redacted.make(""), initialSection: "quick", origin: "https://example.test" }).model

describe("workspace", () => {
  it("retains both children through navigation and child updates", () => {
    const initial = boot()

    if (initial.page._tag !== "Workspace") {
      throw new Error("Expected workspace")
    }

    const changed = Main.update(initial, Main.Message.GotSenderMessage({ message: Sender.Message.LoadedLimits({ limits: Option.none() }) })).model

    if (changed.page._tag !== "Workspace") {
      throw new Error("Expected workspace")
    }

    expect(changed.page.library).toEqual(initial.page.library)
    const navigated = Main.update(changed, Main.Message.NavigatedWorkspace({ section: "library" })).model

    if (navigated.page._tag !== "Workspace") {
      throw new Error("Expected workspace")
    }

    expect(navigated.page.sender).toEqual(changed.page.sender)
    expect(navigated.section).toBe("library")
  })

  it("rejects a late Library handoff when a sender selection appeared", () => {
    const initial = boot()

    if (initial.page._tag !== "Workspace") {
      throw new Error("Expected workspace")
    }

    const sender = Sender.boot({ files: Redacted.make([new File(["first"], "first.txt")]), autoSeal: false, origin: "https://example.test" }).model
    const model = { ...initial, page: { ...initial.page, sender } }

    const message = Library.Message.SucceededLibraryAction({
      generation: model.page.library.generation,
      result: Redacted.make({ kind: "share", snapshot: Redacted.value(model.page.library.snapshot), files: [new File(["second"], "second.txt")] }),
    })

    const next = Main.update(model, Main.Message.GotLibraryMessage({ message })).model

    if (next.page._tag !== "Workspace") {
      throw new Error("Expected workspace")
    }

    expect(Redacted.value(next.page.sender.entries).map((entry) => entry.name)).toEqual(["first.txt"])
    expect(next.handoffBlocked).toBe(true)
  })
  it("preserves the Library on approval and blocks an active sender", () => {
    const initial = boot()

    if (initial.page._tag !== "Workspace") {
      throw new Error("Expected workspace")
    }

    const { library } = initial.page

    const message = Library.Message.SucceededLibraryAction({
      generation: library.generation,
      result: Redacted.make({ kind: "share", snapshot: Redacted.value(library.snapshot), files: [new File(["file"], "file.txt")] }),
    })

    const shared = Main.update(initial, Main.Message.GotLibraryMessage({ message })).model

    if (shared.page._tag !== "Workspace") {
      throw new Error("Expected workspace")
    }

    expect(shared.page.sender.autoSeal).toBe(true)
    expect(shared.page.library.operation).toBe("idle")
    const active = Sender.update(shared.page.sender, Sender.Message.LoadedLimits({ limits: Option.none() })).model
    const pending = { ...shared, page: { ...shared.page, sender: active, library: { ...library, operation: "catalog" as const } } }
    const blocked = Main.update(pending, Main.Message.GotLibraryMessage({ message })).model

    if (blocked.page._tag !== "Workspace") {
      throw new Error("Expected workspace")
    }

    expect(blocked.page.sender.active).toBe(true)
    expect(Redacted.value(blocked.page.sender.entries).map((entry) => entry.name)).toEqual(["file.txt"])
    expect(blocked.handoffBlocked).toBe(true)
  })
})
