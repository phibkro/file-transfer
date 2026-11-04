import { Effect, Fiber } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"
import { saveAll } from "../src/recipient/downloads.ts"

describe("recipient downloads", () => {
  it("interrupts a pending picker and ignores a late selection", async () => {
    const picker = Promise.withResolvers<unknown>()
    const started = Promise.withResolvers<undefined>()
    const getFileHandle = vi.fn()
    vi.stubGlobal("window", {
      showDirectoryPicker: async () => {
        started.resolve(undefined)

        return await picker.promise
      },
    })
    const fiber = Effect.runFork(saveAll([{ name: "private.txt", file: new File(["private"], "private.txt"), url: "blob:private" }]))
    await started.promise
    await Effect.runPromise(Fiber.interrupt(fiber))
    picker.resolve({ getFileHandle })
    await picker.promise
    await Promise.resolve()
    expect(getFileHandle).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("waits for a writable acquisition and aborts it before interruption completes", async () => {
    const writable = Promise.withResolvers<unknown>()
    const started = Promise.withResolvers<undefined>()
    const abort = vi.fn().mockResolvedValue(undefined)

    const createWritable = async () => {
      started.resolve(undefined)

      return await writable.promise
    }

    vi.stubGlobal("window", { showDirectoryPicker: async () => ({ getFileHandle: async () => ({ createWritable }) }) })
    const fiber = Effect.runFork(saveAll([{ name: "private.txt", file: new File(["private"], "private.txt"), url: "blob:private" }]))
    await started.promise
    let interrupted = false

    const receipt = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interrupted = true

      return undefined
    })

    await Promise.resolve()
    expect(interrupted).toBe(false)
    writable.resolve({ abort })
    await receipt
    expect(abort).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it("aborts a live pipe and awaits its cleanup before releasing", async () => {
    const started = Promise.withResolvers<undefined>()
    const writeGate = Promise.withResolvers<undefined>()
    const abortStarted = Promise.withResolvers<undefined>()
    const abortGate = Promise.withResolvers<undefined>()

    const output = new WritableStream({
      write: async () => {
        started.resolve(undefined)
        await writeGate.promise
      },
      abort: async () => {
        abortStarted.resolve(undefined)
        await abortGate.promise
      },
    })

    vi.stubGlobal("window", { showDirectoryPicker: async () => ({ getFileHandle: async () => ({ createWritable: async () => output }) }) })
    const fiber = Effect.runFork(saveAll([{ name: "private.txt", file: new File(["private"], "private.txt"), url: "blob:private" }]))
    await started.promise
    let released = false

    const receipt = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      released = true

      return undefined
    })

    await Promise.resolve()
    expect(released).toBe(false)
    writeGate.resolve(undefined)
    await abortStarted.promise
    expect(released).toBe(false)
    abortGate.resolve(undefined)
    await receipt
    expect(released).toBe(true)
    vi.unstubAllGlobals()
  })
})
