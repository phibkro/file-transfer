import * as fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import { sniff } from "../src/sniff.ts"

/** The UTF-8 bytes of `value`. */
const text = (value: string): readonly number[] => Array.from(new TextEncoder().encode(value))

/** Bytes from parts, in order. */
const bytes = (...parts: readonly (readonly number[])[]): Uint8Array => new Uint8Array(parts.flat())

const iso = (brand: string) => bytes([0, 0, 0, 0x18], text("ftyp"), text(brand), [0, 0, 0, 0])

describe("sniff", () => {
  it.each([
    ["png", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), "image", "image/png"],
    ["jpeg", bytes([0xff, 0xd8, 0xff, 0xe0]), "image", "image/jpeg"],
    ["gif", bytes(text("GIF89a"), [1, 0]), "image", "image/gif"],
    ["webp", bytes(text("RIFF"), [0, 0, 0, 0], text("WEBPVP8 ")), "image", "image/webp"],
    ["avif", iso("avif"), "image", "image/avif"],
    ["m4a", iso("M4A "), "audio", "audio/mp4"],
    ["mov", iso("qt  "), "video", "video/quicktime"],
    ["mp4", iso("isom"), "video", "video/mp4"],
    ["webm", bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f]), "video", "video/webm"],
    ["ogg", bytes(text("OggS"), [0, 2]), "audio", "audio/ogg"],
    ["flac", bytes(text("fLaC"), [0]), "audio", "audio/flac"],
    ["wav", bytes(text("RIFF"), [0, 0, 0, 0], text("WAVEfmt ")), "audio", "audio/wav"],
    ["mp3 with a tag", bytes(text("ID3"), [4, 0]), "audio", "audio/mpeg"],
    ["mp3 frame", bytes([0xff, 0xfb, 0x90, 0x64]), "audio", "audio/mpeg"],
    ["utf-8 text", bytes(text("Hej, verden! Blåbær 🫐\n")), "text", "text/plain"],
  ])("recognises %s", (_, sample, kind, mediaType) => {
    expect(sniff(sample, false)).toEqual({ kind, mediaType })
  })

  it("never renders markup as markup: HTML and SVG are text at most", () => {
    expect(sniff(bytes(text("<!doctype html><script>alert(1)</script>")), true)?.kind).toBe("text")
    expect(sniff(bytes(text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')), true)?.kind).toBe("text")
  })

  it("previews nothing for binary data, empty files or PDFs", () => {
    expect(sniff(bytes([0, 1, 2, 3]), false)).toBeUndefined()
    expect(sniff(new Uint8Array(0), true)).toBeUndefined()
    expect(sniff(bytes(text("%PDF-1.7\n"), [0xe2, 0xe3, 0xcf, 0xd3, 0]), false)).toBeUndefined()
  })

  it("accepts a character cut off at the end of a sample, but not at the end of a whole file", () => {
    const cut = bytes(text("blåbær")).subarray(0, 3)
    expect(sniff(cut, false)?.kind).toBe("text")
    expect(sniff(cut, true)).toBeUndefined()
  })

  it("only ever answers with a kind from the allowlist", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.boolean(), (sample, wholeFile) => {
        const sniffed = sniff(sample, wholeFile)
        expect(sniffed === undefined || ["image", "video", "audio", "text"].includes(sniffed.kind)).toBe(true)
        expect(sniffed?.mediaType ?? "").not.toMatch(/html|svg|xml|javascript/u)
      }),
    )
  })
})
