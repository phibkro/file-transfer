import { Effect } from "effect"
import { describe, expect, test } from "vite-plus/test"
import { pdfResource } from "../src/preview/pdfResources.ts"

describe("PDF resources", () => {
  test("supplies packaged CMaps and standard fonts without a URL fetch", async () => {
    const cmap = await Effect.runPromise(pdfResource("cMapUrl", "UniJIS-UCS2-H.bcmap"))
    const font = await Effect.runPromise(pdfResource("standardFontDataUrl", "LiberationSans-Regular.ttf"))

    expect(cmap.length).toBeGreaterThan(0)
    expect(font.length).toBeGreaterThan(0)
  })

  test("rejects names outside the packaged resource sets", async () => {
    await expect(Effect.runPromise(pdfResource("cMapUrl", "../standard_fonts/LiberationSans-Regular.ttf"))).rejects.toBeDefined()
    await expect(Effect.runPromise(pdfResource("wasmUrl", "anything"))).rejects.toBeDefined()
  })
})
