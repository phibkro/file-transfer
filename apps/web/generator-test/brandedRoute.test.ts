import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { generateFileRoutesEffect } from "../scripts/fileRoutes.ts"

const web = path.resolve(import.meta.dirname, "..")
const repository = path.resolve(web, "../..")

describe("branded generated route parameters", () => {
  it("generates a builder that accepts the decoded brand but rejects a plain string", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "branded-file-route-"))

    try {
      const routes = path.join(root, "src/routes")
      const routing = path.join(root, "src/routing")
      await mkdir(routes, { recursive: true })
      await mkdir(routing, { recursive: true })
      await symlink(path.join(web, "node_modules"), path.join(root, "node_modules"), "dir")
      await copyFile(path.join(web, "src/routing/fileRoute.ts"), path.join(routing, "fileRoute.ts"))
      await copyFile(path.join(web, "src/routing/pathname.ts"), path.join(routing, "pathname.ts"))
      await writeFile(path.join(routes, "__root.ts"), 'import { createRootRoute } from "../routing/fileRoute.ts"\nexport const Route = createRootRoute({})\n')
      await writeFile(
        path.join(routes, "item.$key.ts"),
        'import { Schema } from "effect"\nimport { createFileRoute } from "../routing/fileRoute.ts"\nexport const ItemKey = Schema.String.pipe(Schema.brand("ItemKey"))\nexport const Route = createFileRoute("/item/$key")({ tag: "Item", main: true, params: { key: ItemKey } })\n',
      )
      await Effect.runPromise(generateFileRoutesEffect(root).pipe(Effect.provide(NodeServices.layer)))
      await writeFile(
        path.join(root, "consumer.ts"),
        `import { Effect, Schema } from "effect"
import { ItemKey } from "./src/routes/item.$key.ts"
import { buildPath, parsePath } from "./src/routing/routeTree.gen.ts"
const key = Schema.decodeSync(ItemKey)("hello")
const path = buildPath("/item/$key", { key })
// @ts-expect-error plain strings do not satisfy the route schema brand
buildPath("/item/$key", { key: "hello" })
if (path !== "/item/hello") throw new Error("incorrect path")
const result = Effect.runSync(parsePath(path))
if (result._tag !== "Some" || result.value._tag !== "Item" || result.value.key !== key) throw new Error("incorrect decoded route")
`,
      )

      const compilation = await Effect.runPromise(
        Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
          spawner.exitCode(
            ChildProcess.make(
              path.join(repository, "node_modules/.bin/tsc"),
              [
                "--noEmit",
                "--strict",
                "--skipLibCheck",
                "--target",
                "esnext",
                "--module",
                "esnext",
                "--moduleResolution",
                "bundler",
                "--allowImportingTsExtensions",
                path.join(root, "consumer.ts"),
              ],
              { cwd: root },
            ),
          ),
        ).pipe(Effect.provide(NodeServices.layer)),
      )

      expect(compilation).toBe(0)

      const execution = await Effect.runPromise(
        Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
          spawner.exitCode(ChildProcess.make("bun", [path.join(root, "consumer.ts")], { cwd: root })),
        ).pipe(Effect.provide(NodeServices.layer)),
      )

      expect(execution).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
