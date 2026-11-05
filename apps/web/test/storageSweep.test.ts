import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { openStorage, sweepStaleTransfers } from "../src/capabilities/transfer/storage.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

const setup = () => {
  let held = false
  let heldAtOpenerRequest = false
  const openerRequested = Promise.withResolvers<undefined>()
  let released = Promise.withResolvers<undefined>()
  const enteredRemoval = Promise.withResolvers<undefined>()
  const finishRemoval = Promise.withResolvers<undefined>()
  let pauseRemoval = false

  const removeEntry = vi.fn(async () => {
    if (pauseRemoval) {
      enteredRemoval.resolve(undefined)
      await finishRemoval.promise
    }
  })

  const directory = { getFileHandle: vi.fn() }

  const transfers = {
    async *keys() {
      yield "room"
    },
    removeEntry,
    getDirectoryHandle: vi.fn(async () => directory),
  }

  const root = { getDirectoryHandle: vi.fn(async () => transfers) }

  const locks = {
    request: async (_name: string, options: { ifAvailable?: boolean }, handler: (lock: { name: string } | null) => Promise<undefined>) => {
      if (options.ifAvailable !== true) {
        heldAtOpenerRequest = held
        openerRequested.resolve(undefined)
      }

      if (held && options.ifAvailable === true) {
        await handler(null)

        return undefined
      }

      if (held) {
        await released.promise
      }

      held = true
      released = Promise.withResolvers<undefined>()

      try {
        await handler({ name: _name })

        return undefined
      } finally {
        held = false
        released.resolve(undefined)
      }
    },
  }

  const getDirectory = vi.fn(async () => root)

  vi.stubGlobal("navigator", { locks, storage: { getDirectory } })

  return {
    removeEntry,
    getDirectory,
    openerRequested,
    wasHeldAtOpenerRequest: () => heldAtOpenerRequest,
    enteredRemoval,
    finishRemoval,
    pause: () => {
      pauseRemoval = true
    },
    resume: () => {
      pauseRemoval = false
      finishRemoval.resolve(undefined)
    },
  }
}

describe("stale transfer sweep", () => {
  it("never deletes a room whose opener acquired the lock before the sweep", async () => {
    const fixture = setup()
    const storage = await openStorage("room", 0, new AbortController().signal)
    fixture.removeEntry.mockClear()
    await sweepStaleTransfers()
    expect(fixture.removeEntry).not.toHaveBeenCalled()
    await storage.discard()
  })

  it("holds the room lock through deletion so an opener cannot race it", async () => {
    const fixture = setup()
    fixture.pause()
    const sweep = sweepStaleTransfers()
    await fixture.enteredRemoval.promise
    let opened = false

    const opening = openStorage("room", 0, new AbortController().signal).then((storage) => {
      opened = true

      return storage
    })

    await Promise.resolve()
    expect(opened).toBe(false)
    expect(fixture.getDirectory).toHaveBeenCalledTimes(1)
    fixture.resume()
    await sweep
    const storage = await opening
    expect(opened).toBe(true)
    await storage.discard()
  })

  it("retains the room lock until the pending removal settles", async () => {
    const fixture = setup()
    fixture.pause()
    const sweep = sweepStaleTransfers()
    await fixture.enteredRemoval.promise
    // Let the lock callback finish if deletion was incorrectly detached from it.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    const opening = openStorage("room", 0, new AbortController().signal)
    await fixture.openerRequested.promise
    expect(fixture.wasHeldAtOpenerRequest()).toBe(true)
    expect(fixture.getDirectory).toHaveBeenCalledTimes(1)
    fixture.resume()
    await sweep
    const storage = await opening
    await storage.discard()
  })
})
