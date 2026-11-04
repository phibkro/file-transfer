import { describe, expect, it, vi } from "vite-plus/test"
import { ownDownloads, saveAll } from "../src/recipient/downloads.ts"
import type { RecipientSession } from "../src/recipient.ts"

describe("recipient downloads", () => {
  it("releases while the native picker is pending and ignores a late selection", async () => {
    const picker = Promise.withResolvers<unknown>()
    const getFileHandle = vi.fn()
    vi.stubGlobal("window", { showDirectoryPicker: async () => await picker.promise })
    const controller = new AbortController()
    const pending = saveAll([{ name: "private.txt", file: new File(["private"], "private.txt"), url: "blob:private" }], controller.signal)
    controller.abort()
    expect(await pending).toBe("cancelled")
    picker.resolve({ getFileHandle })
    await picker.promise
    await Promise.resolve()
    expect(getFileHandle).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("waits for the session receipt and fences a pending picker on disposal", async () => {
    const picker = Promise.withResolvers<unknown>()
    const release = Promise.withResolvers<undefined>()

    const disposed = vi.fn(async () => {
      await release.promise
    })

    const markSaved = vi.fn()
    const getFileHandle = vi.fn()
    vi.stubGlobal("window", { showDirectoryPicker: async () => await picker.promise })

    const session: RecipientSession = {
      currentSnapshot: () => ({
        phase: "Completed",
        status: "complete",
        statusText: "Complete",
        files: [{ name: "private.txt", size: 1, file: new File(["x"], "private.txt"), url: "blob:private" }],
        totalBytes: 1,
        mobileWarning: false,
        spaceShortfall: undefined,
        spaceChecking: false,
        progress: { done: 1, total: 1 },
        filesRemoved: false,
        unsavedFiles: true,
        failure: undefined,
        failureDetail: undefined,
        path: "relay",
        summary: { bytes: 1, seconds: 1, reconnects: 0, direct: false, secondsToDirect: undefined, directDrops: 0 },
      }),
      subscribe: () => () => undefined,
      accept: async () => undefined,
      decline: () => undefined,
      rename: () => undefined,
      markSaved: () => {
        markSaved()
      },
      removeAll: async () => undefined,
      dispose: disposed,
    }

    const owner = ownDownloads(session)
    const saving = owner.saveAll()
    let finished = false

    const closing = owner.dispose().then(() => {
      finished = true

      return undefined
    })

    expect(await saving).toBe("cancelled")
    expect(finished).toBe(false)
    release.resolve(undefined)
    await closing
    picker.resolve({ getFileHandle })
    await picker.promise
    expect(markSaved).not.toHaveBeenCalled()
    expect(getFileHandle).not.toHaveBeenCalled()
    expect(disposed).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
})
