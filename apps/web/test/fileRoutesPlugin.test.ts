import path from "node:path"
import { Data, Effect } from "effect"
import { createServer } from "vite-plus"
import { describe, expect, it, vi } from "vite-plus/test"
import { fileRoutes } from "../scripts/fileRoutesPlugin.ts"

class WatchTestError extends Data.TaggedError("WatchTestError")<{ readonly cause: unknown }> {}

const generate = vi.hoisted(() => vi.fn<(root: string) => Promise<void>>())

vi.mock("../scripts/fileRoutes.ts", () => ({
  generateFileRoutesEffect: (root: string) =>
    Effect.tryPromise({
      try: async () => {
        await generate(root)
      },
      catch: (cause) => new WatchTestError({ cause }),
    }),
}))

describe("file route watcher", () => {
  it("serializes writes, reports failures, recovers and detaches on close", async () => {
    generate.mockReset()
    generate.mockResolvedValueOnce()

    const root = path.resolve(import.meta.dirname, "..")
    const server = await createServer({ configFile: false, root, plugins: [fileRoutes()], server: { middlewareMode: true } })

    let failed!: () => void

    const failure = new Promise<void>((resolve) => {
      failed = resolve
    })

    const errors = vi.spyOn(server.config.logger, "error").mockImplementation(() => {
      failed()
    })

    const messages = vi.spyOn(server.ws, "send").mockImplementation(() => {})

    let release!: () => void
    let started!: () => void

    const running = new Promise<void>((resolve) => {
      started = resolve
    })

    generate.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
        started()
      })
    })

    generate.mockRejectedValueOnce(new Error("invalid route"))
    let recovered!: () => void

    const recovery = new Promise<void>((resolve) => {
      recovered = resolve
    })

    generate.mockImplementationOnce(async () => {
      recovered()
    })

    const route = path.resolve(root, "src/routes/index.ts")

    try {
      server.watcher.emit("change", route)
      await running
      server.watcher.emit("unlink", route)
      server.watcher.emit("add", route)
      expect(generate).toHaveBeenCalledTimes(2)
      release()
      await failure
      expect(errors).toHaveBeenCalledOnce()
      expect(messages).toHaveBeenCalledOnce()
      server.watcher.emit("change", route)
      await recovery
      expect(generate).toHaveBeenCalledTimes(4)
    } finally {
      await server.close()
    }

    server.watcher.emit("change", route)
    expect(generate).toHaveBeenCalledTimes(4)
  })
})
