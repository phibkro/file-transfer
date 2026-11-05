import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { openStorage } from "../src/capabilities/transfer/storage.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("storage acquisition cancellation", () => {
  it("cancels a blocked lock without opening origin storage", async () => {
    let requested: AbortSignal | undefined
    const getDirectory = vi.fn()
    vi.stubGlobal("navigator", {
      locks: {
        request: async (_name: string, options: { signal: AbortSignal }) => {
          requested = options.signal
          const { promise, reject } = Promise.withResolvers<undefined>()
          options.signal.addEventListener(
            "abort",
            () => {
              reject(options.signal.reason)
            },
            { once: true },
          )

          await promise
        },
      },
      storage: { getDirectory },
    })
    const controller = new AbortController()
    const opening = openStorage("room", 1, controller.signal)
    expect(requested).toBe(controller.signal)
    controller.abort()
    await expect(opening).rejects.toMatchObject({ name: "AbortError" })
    expect(getDirectory).not.toHaveBeenCalled()
  })

  it("releases an acquired lock when opening is cancelled during origin storage lookup", async () => {
    const root = Promise.withResolvers<{ getDirectoryHandle: () => undefined }>()
    const released = Promise.withResolvers<undefined>()
    const getDirectory = vi.fn(async () => await root.promise)
    const getDirectoryHandle = vi.fn(() => undefined)
    vi.stubGlobal("navigator", {
      locks: {
        request: async (_name: string, _options: { signal: AbortSignal }, lockHandler: () => Promise<undefined>) => {
          await lockHandler()
          released.resolve(undefined)
        },
      },
      storage: { getDirectory },
    })
    const controller = new AbortController()
    const opening = openStorage("room", 1, controller.signal)
    await Promise.resolve()
    controller.abort()
    root.resolve({ getDirectoryHandle })
    await expect(opening).rejects.toMatchObject({ name: "AbortError" })
    await released.promise
    expect(getDirectoryHandle).not.toHaveBeenCalled()
  })
})
