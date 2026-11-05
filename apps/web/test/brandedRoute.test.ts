import { Effect, Schema } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { renderFileRoutes } from "../scripts/renderFileRoutes.ts"
import { ItemKey } from "./branded/routes/item.$key.ts"
import { buildPath, parsePath } from "./branded/routing/routeTree.gen.ts"

const routes = [
  {
    file: "item.$key.ts",
    id: "/item/$key",
    path: "/item/$key",
    parent: "__root",
    tag: "Item",
    main: true,
    layout: false,
    segments: ["item", "$key"],
    staticPage: false,
  },
] as const

describe("branded file route parameters", () => {
  it("preserves the schema type in generated builders", () => {
    const key = Schema.decodeSync(ItemKey)("hello")
    const path = buildPath("/item/$key", { key })

    expect(path).toBe("/item/hello")
    expect(Effect.runSync(parsePath(path ?? ""))).toMatchObject({ _tag: "Some", value: { _tag: "Item", key } })
    // @ts-expect-error an unbranded string cannot be used as an ItemKey
    expect(buildPath("/item/$key", { key: "hello" })).toBe("/item/hello")
    expect(renderFileRoutes(routes)).toContain("Schema.Schema.Type<typeof route0.options.params.key>")
    expect(renderFileRoutes(routes)).toContain("Schema.is(route0.options.params.key)")
  })
})
