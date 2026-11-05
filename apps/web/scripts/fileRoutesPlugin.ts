import { NodeServices } from "@effect/platform-node"
import path from "node:path"
import { Effect, Exit, FiberSet, Queue, Scope, Semaphore } from "effect"
import type { Plugin } from "vite-plus"
import { generateFileRoutesEffect } from "./fileRoutes.ts"

export const fileRoutes = (): Plugin => {
  let root = ""

  return {
    name: "file-routes",
    enforce: "pre",
    configResolved(config) {
      root = config.root

      return Effect.runPromise(generateFileRoutesEffect(root).pipe(Effect.provide(NodeServices.layer)))
    },
    configureServer(server) {
      const directory = `${path.resolve(root, "src/routes")}${path.sep}`
      // One active generation and one sliding pending signal; closing the server interrupts the owned worker.
      const queue = Effect.runSync(Queue.make<null>({ capacity: 1, strategy: "sliding" }))
      const scope = Scope.makeUnsafe()
      const semaphore = Semaphore.makeUnsafe(1)
      const run = Effect.runSync(FiberSet.makeRuntime().pipe(Scope.provide(scope)))
      let disposed = false
      let dirty = false
      let failed = false
      let revision = 0

      server.watcher.add(directory)
      server.middlewares.use((request, response, next) => {
        if (!disposed && (dirty || failed) && request.headers.accept?.includes("text/html") === true) {
          response.statusCode = 503
          response.end("Route generation is incomplete. Fix route errors and reload.")

          return
        }

        next()
      })

      const generation = semaphore
        .withPermits(1)(generateFileRoutesEffect(root))
        .pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.sync(() => {
                failed = true
                server.config.logger.error(String(error))
                server.ws.send({ type: "error", err: { message: String(error), stack: error.stack ?? "" } })
              }),
            onSuccess: () =>
              Effect.sync(() => {
                failed = false
              }),
          }),
        )

      const work = Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid))

        while (true) {
          yield* Queue.take(queue)

          const current = revision

          yield* generation

          if (current === revision) {
            dirty = false
          }
        }
      })

      run(work.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

      const regenerate = (file: string) => {
        if (disposed || !path.resolve(file).startsWith(directory)) {
          return
        }

        revision++
        dirty = true
        Queue.offerUnsafe(queue, null)
      }

      const dispose = () => {
        if (disposed) {
          return
        }

        disposed = true
        Queue.shutdownUnsafe(queue)
        void Effect.runPromise(Scope.close(scope, Exit.void))
        server.watcher.off("add", regenerate).off("change", regenerate).off("unlink", regenerate).off("addDir", regenerate).off("unlinkDir", regenerate)
        server.httpServer?.off("close", dispose)
        server.watcher.off("close", dispose)
      }

      server.watcher.on("add", regenerate).on("change", regenerate).on("unlink", regenerate).on("addDir", regenerate).on("unlinkDir", regenerate)
      server.httpServer?.once("close", dispose)
      server.watcher.once("close", dispose)
    },
  }
}
