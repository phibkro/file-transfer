// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/**
 * The name profile (docs/parcel.md, "Name profile"): names every common file system can store as written.
 *
 * Adapted from cn-homage's `packages/core/src/7-bulk/names.ts` (same author), which cleans zip entry names by
 * rewriting them. A parcel receiver rejects instead of rewriting; renaming on write belongs to `libraries/sink`.
 * Changes: format characters (Cf, such as U+202E and zero-width spaces), line and paragraph separators, and code
 * points unassigned in Unicode 15.1 (Cn) are rejected too; collisions compare full Unicode case folding (so "straße" meets "STRASSE") rather than
 * lower-casing; device names include COM and LPT with superscript digits, as Microsoft's naming rules and
 * disktree's `misread_by_win32` do.
 */
import { ParcelError } from "./errors.ts"
import { caseFoldings, forbiddenCodePointRanges } from "./unicode.ts"

export const maximumNameBytes = 4096
export const maximumSegmentBytes = 255

const textEncoder = new TextEncoder()
const byteLength = (text: string): number => textEncoder.encode(text).length

/** The characters NTFS and exFAT reject (besides controls and `/`). */
const reservedAscii = new Set(Array.from('\\:*?"<>|', (character) => character.codePointAt(0) ?? 0))

const isForbiddenCodePoint = (codePoint: number): boolean => {
  if (reservedAscii.has(codePoint)) return true
  let low = 0
  let high = forbiddenCodePointRanges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [start, end] = forbiddenCodePointRanges[middle] ?? [0, -1]
    if (codePoint < start) high = middle - 1
    else if (codePoint > end) low = middle + 1
    else return true
  }
  return false
}

const deviceStems = new Set(["con", "prn", "aux", "nul"])
const numberedDevice = /^(com|lpt)[1-9¹²³]$/

/** Whether Windows reads a segment as a device: its part before the first dot, trailing spaces removed, ASCII lowercased. */
export const isWindowsDeviceName = (segment: string): boolean => {
  const stem = (segment.split(".")[0] ?? "").replace(/ +$/, "").replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  return deviceStems.has(stem) || numberedDevice.test(stem)
}

const foldings = new Map(caseFoldings.map(([codePoint, ...folded]) => [codePoint ?? 0, String.fromCodePoint(...folded)]))

/**
 * The names a receiver accepts depend on NFC, so every receiver needs a normalizer at Unicode 15.1 or later. Unicode
 * 15.1 added no character that affects NFC (DerivedAge.txt), so a normalizer that reorders U+10EFD (added in 15.0,
 * canonical combining class 220) before U+0301 (class 230) is new enough. Exported with the normalizer as a
 * parameter so tests can show an old one is refused.
 */
export const checkNormalizer = (normalize: (text: string) => string = (text) => text.normalize("NFC")): void => {
  if (normalize("x\u0301\u{10EFD}") !== "x\u{10EFD}\u0301") {
    throw new ParcelError("unsupported-runtime", "this runtime's Unicode normalization predates Unicode 15.1, so it cannot check names")
  }
}

let normalizerChecked = false
const requireModernNormalizer = (): void => {
  if (normalizerChecked) return
  checkNormalizer()
  normalizerChecked = true
}

/** Full default case folding (Unicode 15.1, statuses C and F). */
export const caseFold = (text: string): string => Array.from(text, (character) => foldings.get(character.codePointAt(0) ?? 0) ?? character).join("")

/** The key two names are compared by: NFC of the case-folded name. */
export const nameKey = (name: string): string => {
  requireModernNormalizer()
  return caseFold(name).normalize("NFC")
}

/** Why a single name breaks the profile, or undefined when it follows it. */
export const nameProblem = (name: string): string | undefined => {
  requireModernNormalizer()
  // Forbidden code points first (rule 3 before rule 1): code points unassigned in Unicode 15.1 never reach the
  // normalizer, so runtimes with newer Unicode data name the same problem. Lone surrogates come out of the code
  // point iteration as themselves and are forbidden (Cs).
  for (const character of name) {
    const codePoint = character.codePointAt(0) ?? 0
    if (isForbiddenCodePoint(codePoint)) return `contains the forbidden character U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
  }
  if (name.normalize("NFC") !== name) return "is not in Unicode Normalization Form C"
  if (byteLength(name) > maximumNameBytes) return `is longer than ${maximumNameBytes} bytes`
  for (const segment of name.split("/")) {
    if (segment.length === 0) return "has an empty segment"
    if (segment === "." || segment === "..") return `has a "${segment}" segment`
    if (byteLength(segment) > maximumSegmentBytes) return `has a segment longer than ${maximumSegmentBytes} bytes`
    if (segment.endsWith(".") || segment.endsWith(" ")) return "has a segment ending in a dot or a space"
    if (isWindowsDeviceName(segment)) return `has the Windows device name "${segment}"`
  }
  return undefined
}

/** Why a set of names collides, or undefined: no two share a key, and no file's key is a folder of another's. */
export const nameCollision = (names: ReadonlyArray<string>): string | undefined => {
  const keys = names.map(nameKey)
  const seen = new Set<string>()
  for (const [index, key] of keys.entries()) {
    if (seen.has(key)) return `"${names[index]}" collides with another name, ignoring case and normalisation`
    seen.add(key)
  }
  const folders = new Set(
    keys.flatMap((key) =>
      key
        .split("/")
        .slice(0, -1)
        .map((_, index, segments) => segments.slice(0, index + 1).join("/")),
    ),
  )
  for (const [index, key] of keys.entries()) {
    if (folders.has(key)) return `"${names[index]}" is both a file and a folder`
  }
  return undefined
}
