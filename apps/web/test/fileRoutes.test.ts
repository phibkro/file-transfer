import { describe, expect, it } from "vite-plus/test"
import { inventory, renderFileRoutes } from "../scripts/fileRoutes.ts"
import { buildPath, parsePath, routeTree } from "../src/routing/routeTree.gen.ts"

const root = { file: "__root.ts", source: "" }
const file = (name: string, id: string, tag: string) => ({ file: name + ".ts", source: `export const Route = createFileRoute("${id}")({ tag: "${tag}" })` })

describe("file route generation", () => {
  it("is deterministic and rejects conflicting paths, missing layouts, and ambiguous parameters", () => {
    const routes = [root, file("_workspace", "/_workspace", "Workspace"), file("_workspace.index", "/_workspace/", "Home")]
    expect(renderFileRoutes(inventory(routes))).toBe(renderFileRoutes(inventory([...routes].reverse())))
    expect(() => inventory([...routes, file("index", "/", "Other")])).toThrow("Duplicate route path")
    expect(() => inventory([root, file("_missing.index", "/_missing/", "Home")])).toThrow("Missing parent")
    expect(() => inventory([root, file("r.$first", "/r/$first", "First"), file("r.$second", "/r/$second", "Second")])).toThrow("Ambiguous")
    expect(() => inventory([root, file("bad[syntax]", "/bad", "Bad")])).toThrow("Unsupported")
    expect(() => inventory([root, file("renamed", "/old", "Old")])).toThrow('expected createFileRoute("/renamed")')
  })
})

describe("pathname router", () => {
  it("round trips recipient paths and rejects fragment and query input", () => {
    const roomIdentifier = "abcdefghijklmnopqrstuv"
    expect(buildPath("/r/$roomIdentifier", { roomIdentifier })).toBe("/r/" + roomIdentifier)
    expect(parsePath("/r/" + roomIdentifier + "/")).toMatchObject({ _tag: "Recipient", roomIdentifier })
    expect(parsePath("/r/short")).toMatchObject({ _tag: "QuickShare" })
    expect(parsePath("/r/" + roomIdentifier + "#secret")).toBeUndefined()
    expect(parsePath("/library?query=secret")).toBeUndefined()
    expect(parsePath("/l%69brary")).toMatchObject({ _tag: "Library" })
    expect(parsePath("/%ZZ")).toBeUndefined()
  })
  it("identifies the shared layout parent", () => {
    expect(routeTree.routes.find((route) => route.id === "/_workspace/")?.parent).toBe("/_workspace")
    expect(routeTree.routes.find((route) => route.id === "/_workspace/library")?.parent).toBe("/_workspace")
  })
})

if (false) {
  buildPath("/r/$roomIdentifier", { roomIdentifier: "abcdefghijklmnopqrstuv" })
  // @ts-expect-error dynamic parameters are required
  buildPath("/r/$roomIdentifier")
  // @ts-expect-error parameter names are checked
  buildPath("/r/$roomIdentifier", { wrong: "x" })
  // @ts-expect-error extra parameter names are rejected
  buildPath("/r/$roomIdentifier", { roomIdentifier: "x", extra: "x" })
  // @ts-expect-error paths come from the route files
  buildPath("/missing")
}
