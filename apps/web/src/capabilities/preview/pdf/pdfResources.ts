import { Data, Effect } from "effect"
import { cMaps, standardFonts } from "./pdfResourceManifest.ts"

class PdfResourceUnavailable extends Data.TaggedError("PdfResourceUnavailable") {}

const resources = new Map([
  ["cMapUrl", cMaps],
  ["standardFontDataUrl", standardFonts],
])

// Only names in the pinned PDF.js resource manifest can be decoded.
export const pdfResource = (kind: string, filename: string): Effect.Effect<Uint8Array, PdfResourceUnavailable> =>
  Effect.suspend(() => {
    const url = resources.get(kind)?.get(filename)

    if (url === undefined || !url.startsWith("data:") || !url.includes(";base64,")) {
      return Effect.fail(new PdfResourceUnavailable())
    }

    return Effect.try({
      try: () => {
        const binary = atob(url.slice(url.indexOf(",") + 1))

        return Uint8Array.from(binary, (character) => character.charCodeAt(0))
      },
      catch: () => new PdfResourceUnavailable(),
    })
  })
