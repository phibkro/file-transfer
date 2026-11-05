import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { generateFileRoutesEffect, inventory, renderFileRoutes } from "../scripts/fileRoutes.ts"

const root = { file: "__root.ts", source: "export const Route = createRootRoute({})" }
const file = (name: string, id: string, tag: string) => ({ file: `${name}.ts`, source: `export const Route = createFileRoute("${id}")({ tag: "${tag}" })` })

const generateFileRoutes = async (directory: string, check = false): Promise<void> => {
  await Effect.runPromise(generateFileRoutesEffect(directory, check).pipe(Effect.provide(NodeServices.layer)))
}

describe("file route generation", () => {
  it("is deterministic and rejects conflicts, missing layouts and ambiguous parameters", () => {
    const routes = [root, file("_workspace", "/_workspace", "Workspace"), file("_workspace.index", "/_workspace/", "Home")]
    expect(renderFileRoutes(inventory(routes))).toEqual(renderFileRoutes(inventory([...routes.slice(1), ...routes.slice(0, 1)])))
    expect(() => inventory([...routes, file("index", "/", "Other")])).toThrow("Duplicate route path")
    expect(() => inventory([root, file("_missing.index", "/_missing/", "Home")])).toThrow("Missing parent")
    expect(() => inventory([root, file("r.$first", "/r/$first", "First"), file("r.$second", "/r/$second", "Second")])).toThrow("Ambiguous")
    expect(() => inventory([root, file("bad[syntax]", "/bad", "Bad")])).toThrow("Unsupported")
    expect(() => inventory([root, file("r.$id.$id", "/r/$id/$id", "Repeated")])).toThrow("Duplicate route parameter")
    expect(() => inventory([root, file("renamed", "/old", "Old")])).toThrow('expected createFileRoute("/renamed")')
    expect(() => inventory([root, root])).toThrow("Duplicate route file")
  })

  it("validates root and rejects ambiguous options rather than guessing", () => {
    for (const source of [
      "",
      "export const Route = createRootRoute()",
      "export const Route = other({})",
      "export const Route = createRootRoute({ ...options })",
    ]) {
      expect(() => inventory([{ ...root, source }])).toThrow()
    }

    for (const options of [
      '{ tag: "Home", ...other }',
      '{ tag: "Home", "tag": "Other" }',
      '{ tag: "Home", [name]: true }',
      "{ tag: variable }",
      '{ tag: "Home", main: variable }',
      '{ tag: "Home", main: true, staticPage: { view: view } }',
      '{ tag: "Home", workspaceSection: "quick" }',
      '{ tag: "Home", main: true, workspaceSection: "quick" }',
      '{ tag: "Home", params: { id: schema, ...other } }',
      '{ tag: "Home", params: { id: schema, "id": schema } }',
    ]) {
      expect(() => inventory([root, { file: "index.ts", source: `export const Route = createFileRoute("/")(${options})` }])).toThrow()
    }

    expect(
      inventory([
        root,
        { file: "about.ts", source: 'export const Route = createFileRoute("/about")({ tag: "About", staticPage: { view: () => import("./page") } })' },
      ])[0]?.staticPage,
    ).toBe(true)
    expect(inventory([root, { file: "index.ts", source: 'export const Route = createFileRoute("/")({ "tag": "Home", "main": true })' }])[0]?.main).toBe(true)
  })

  it("rejects static pages with dynamic parameters", () => {
    const dynamic = {
      file: "r.$id.ts",
      source: 'export const Route = createFileRoute("/r/$id")({ tag: "Recipient", staticPage: { view: view }, params: { id: schema } })',
    }

    expect(() => inventory([root, dynamic])).toThrow("Static page requires a literal page path")
  })

  it("detects stale output and regenerates after add, rename and delete", async () => {
    const directory = await mkdtemp(path.join(import.meta.dirname, ".route-test-"))
    const routes = path.join(directory, "src/routes")
    const output = path.join(directory, "src/routing/routeTree.gen.ts")

    try {
      await mkdir(routes, { recursive: true })
      await mkdir(path.join(directory, "src/routing"), { recursive: true })
      await writeFile(path.join(routes, root.file), root.source)
      await writeFile(path.join(routes, "index.ts"), file("index", "/", "Home").source)
      await expect(generateFileRoutes(directory, true)).rejects.toThrow("stale")
      await generateFileRoutes(directory)
      await expect(generateFileRoutes(directory, true)).resolves.toBeUndefined()
      await writeFile(path.join(routes, "about.ts"), file("about", "/about", "About").source)
      await expect(generateFileRoutes(directory, true)).rejects.toThrow("stale")
      await generateFileRoutes(directory)
      expect(await readFile(output, "utf-8")).toContain("/about")
      await rename(path.join(routes, "about.ts"), path.join(routes, "privacy.ts"))
      await expect(generateFileRoutes(directory)).rejects.toThrow("expected createFileRoute")
      await writeFile(path.join(routes, "privacy.ts"), file("privacy", "/privacy", "Privacy").source)
      await generateFileRoutes(directory)
      expect(await readFile(output, "utf-8")).toContain("/privacy")
      await rm(path.join(routes, "privacy.ts"))
      await generateFileRoutes(directory)
      expect(await readFile(output, "utf-8")).not.toContain("/privacy")
      await mkdir(path.join(routes, "nested"))
      await expect(generateFileRoutes(directory)).rejects.toThrow("Unsupported route entry")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
