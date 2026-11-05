import { Schema } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { createFileRoute, createRootRoute } from "../src/routing/fileRoute.ts"
import { Route as privacyRoute } from "../src/routes/privacy.ts"
import { buildRoutePath, matchPath } from "../src/routing/pathname.ts"
import { buildPath, parsePath } from "../src/routing/routeTree.gen.ts"

const word = Schema.String.check(Schema.isPattern(/^[a-z ]+$/u))

const routes = [
  { segments: ["item", "new"], make: () => ({ tag: "new" }) },
  {
    segments: ["item", { name: "first", schema: word }, { name: "second", schema: word }],
    make: (params: Readonly<Record<string, string>>) => ({ tag: "item", ...params }),
  },
  { segments: ["item", { name: "name", schema: word }], make: (params: Readonly<Record<string, string>>) => ({ tag: "named", ...params }) },
] as const

describe("pathname routing", () => {
  it("rejects invalid generated paths without fallback or exception", () => {
    expect(parsePath("/library/extra")).toBeUndefined()
    expect(parsePath("/r/short")).toBeUndefined()
    expect(buildPath("/r/$roomIdentifier", { roomIdentifier: "short" })).toBeUndefined()
    const roomIdentifier = "abcdefghijklmnopqrstuv"
    const path = buildPath("/r/$roomIdentifier", { roomIdentifier })
    expect(path).toBe(`/r/${roomIdentifier}`)
    expect(parsePath(path ?? "")).toMatchObject({ _tag: "Recipient", roomIdentifier })
  })

  it("requires exact generated path parameters", () => {
    const extra = { roomIdentifier: "abcdefghijklmnopqrstuv", extra: "x" }
    // @ts-expect-error extra keys are rejected even on variables
    expect(buildPath("/r/$roomIdentifier", extra)).toBeUndefined()
    // @ts-expect-error dynamic parameters are required
    expect(buildPath("/r/$roomIdentifier")).toBeUndefined()
    // @ts-expect-error unknown paths are rejected
    expect(() => buildPath("/missing")).toThrow()
    // @ts-expect-error route identifiers are generated from route files
    expect(createFileRoute("/not-a-file")).toBeTypeOf("function")

    const rootMetadata = { tag: "Root" }
    // @ts-expect-error root metadata is not supported, even through a variable
    expect(createRootRoute(rootMetadata).id).toBe("__root")
    // @ts-expect-error a static page cannot also be a main page
    expect(createFileRoute("/privacy")({ tag: "Privacy", main: true, staticPage: privacyRoute.options.staticPage }).id).toBe("/privacy")
    // @ts-expect-error workspace sections require a main route
    expect(createFileRoute("/_workspace/library")({ tag: "Library", workspaceSection: "library" }).id).toBe("/_workspace/library")
    // @ts-expect-error workspace sections cannot be attached to a non-workspace route
    expect(createFileRoute("/privacy")({ tag: "Privacy", main: true, workspaceSection: "library" }).id).toBe("/privacy")
    const parameters = { roomIdentifier: Schema.String, extra: Schema.String }
    // @ts-expect-error path parameter schemas cannot contain extra keys
    expect(createFileRoute("/r/$roomIdentifier")({ tag: "Recipient", params: parameters }).id).toBe("/r/$roomIdentifier")
  })

  it("matches only complete paths and decodes each segment", () => {
    expect(matchPath("/item/new", routes)).toEqual({ tag: "new" })
    expect(matchPath("/item/a", routes)).toEqual({ tag: "named", name: "a" })
    expect(matchPath("/item/hello%20there/world/", routes)).toEqual({ tag: "item", first: "hello there", second: "world" })

    for (const path of [
      "/item/new/extra/more",
      "/item/a/b/c",
      "/item/a%2Fb/c",
      "/item/%ZZ/b",
      "/item//b",
      "/item/a/b?x",
      "/item/a/b#secret",
      "item/a/b",
      "/item/a/123",
    ]) {
      expect(matchPath(path, routes)).toBeUndefined()
    }
  })

  it("validates and encodes each parameter when building", () => {
    const { segments } = routes[1]
    expect(buildRoutePath(segments, { first: "hello there", second: "world" })).toBe("/item/hello%20there/world")
    expect(buildRoutePath(segments, { first: "hello", second: "123" })).toBeUndefined()
    expect(buildRoutePath(segments, { first: "hello/world", second: "world" })).toBeUndefined()
    expect(buildRoutePath(segments, { first: "hello", second: "world", extra: "x" })).toBeUndefined()
    expect(buildRoutePath(segments, { first: "hello" })).toBeUndefined()
  })
})
