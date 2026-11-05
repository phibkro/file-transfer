import { Effect } from "effect"
import { describe, expect, test } from "vite-plus/test"
import { pdfResource } from "../src/capabilities/preview/pdf/pdfResources.ts"

describe("PDF resources", () => {
  test("rejects names outside the packaged resource sets", async () => {
    await expect(Effect.runPromise(pdfResource("cMapUrl", "../standard_fonts/LiberationSans-Regular.ttf"))).rejects.toBeDefined()
    await expect(Effect.runPromise(pdfResource("wasmUrl", "anything"))).rejects.toBeDefined()
  })
})
