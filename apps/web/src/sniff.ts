/**
 * Decides whether a file can be previewed, and how, from its first bytes alone. Names and the manifest's `mediaType`
 * are claims anyone can make (docs/parcel.md forbids rendering on the strength of `mediaType`), so only a format's own
 * signature counts, and only formats on this allowlist are ever rendered. Markup (HTML, SVG, XML) is never rendered as
 * markup: at most it is shown as text. The preview itself runs in a sandboxed frame (preview.ts), so this list limits
 * what reaches the browser's decoders there, not what could reach the app.
 */

export type PreviewKind = "image" | "video" | "audio" | "text"

export interface Sniffed {
  readonly kind: PreviewKind
  /** The type the preview's Blob is given, so the browser never guesses one. */
  readonly mediaType: string
}

/** Bytes to read from the start of a file before sniffing. */
export const sniffLength = 4096

/** The largest text shown in a preview; the rest of the file is left out. */
export const textPreviewLength = 64 * 1024

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte)

/** The bytes of an ASCII signature such as `ftyp`. */
const ascii = (text: string): readonly number[] => Array.from(new TextEncoder().encode(text))

/** ISO base media file format (MP4, MOV, M4A, AVIF): `ftyp` at offset 4, then the major brand. */
const isoBrand = (bytes: Uint8Array): string | undefined =>
  startsWith(bytes, ascii("ftyp"), 4) && bytes.length >= 12 ? String.fromCodePoint(...bytes.subarray(8, 12)) : undefined

const imageBrands = new Set(["avif", "avis"])
const audioBrands = new Set(["M4A ", "M4B "])

const signatures: readonly { readonly matches: (bytes: Uint8Array) => boolean; readonly sniffed: Sniffed }[] = [
  { matches: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), sniffed: { kind: "image", mediaType: "image/png" } },
  { matches: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]), sniffed: { kind: "image", mediaType: "image/jpeg" } },
  {
    matches: (bytes) => startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a")),
    sniffed: { kind: "image", mediaType: "image/gif" },
  },
  {
    matches: (bytes) => startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8),
    sniffed: { kind: "image", mediaType: "image/webp" },
  },
  { matches: (bytes) => imageBrands.has(isoBrand(bytes) ?? ""), sniffed: { kind: "image", mediaType: "image/avif" } },
  { matches: (bytes) => audioBrands.has(isoBrand(bytes) ?? ""), sniffed: { kind: "audio", mediaType: "audio/mp4" } },
  { matches: (bytes) => isoBrand(bytes) === "qt  ", sniffed: { kind: "video", mediaType: "video/quicktime" } },
  { matches: (bytes) => isoBrand(bytes) !== undefined, sniffed: { kind: "video", mediaType: "video/mp4" } },
  { matches: (bytes) => startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]), sniffed: { kind: "video", mediaType: "video/webm" } },
  { matches: (bytes) => startsWith(bytes, ascii("OggS")), sniffed: { kind: "audio", mediaType: "audio/ogg" } },
  { matches: (bytes) => startsWith(bytes, ascii("fLaC")), sniffed: { kind: "audio", mediaType: "audio/flac" } },
  {
    matches: (bytes) => startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WAVE"), 8),
    sniffed: { kind: "audio", mediaType: "audio/wav" },
  },
  {
    // An ID3 tag, or an MPEG audio frame header: 11 set sync bits, MPEG version not reserved, layer III.
    matches: (bytes) =>
      startsWith(bytes, ascii("ID3")) || (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0 && ((bytes[1] ?? 0) & 0x06) === 0x02),
    sniffed: { kind: "audio", mediaType: "audio/mpeg" },
  },
]

/** Text: no NUL byte and valid UTF-8, allowing a character cut off at the end of the sample. */
const isText = (bytes: Uint8Array, wholeFile: boolean): boolean => {
  if (bytes.length === 0 || bytes.includes(0)) {
    return false
  }

  // A sample can end inside a multi-byte character; up to three trailing bytes are left out when the file goes on.
  const decoder = new TextDecoder("utf-8", { fatal: true })

  for (let cut = 0; cut <= (wholeFile ? 0 : Math.min(3, bytes.length - 1)); cut++) {
    try {
      decoder.decode(bytes.subarray(0, bytes.length - cut))

      return true
    } catch {
      // Try one byte shorter.
    }
  }

  return false
}

/**
 * How to preview a file whose first bytes are `bytes`, or undefined when it cannot be previewed. `wholeFile` says
 * whether `bytes` is the entire file (so a cut-off character at the end is an error, not the sample's edge).
 */
export const sniff = (bytes: Uint8Array, wholeFile: boolean): Sniffed | undefined =>
  signatures.find((signature) => signature.matches(bytes))?.sniffed ?? (isText(bytes, wholeFile) ? { kind: "text", mediaType: "text/plain" } : undefined)
