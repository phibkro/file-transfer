// oxlint-effect-plugin ignore-file:
// reason: the wire-format core is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/**
 * The manifest (docs/format.md, "Manifest"): what the transfer contains. Its plaintext fills exactly one record: a
 * 4-byte big-endian JSON length, the UTF-8 JSON, then zero bytes. A fixed length lets a receiver parse the stream
 * without delimiters and hides how long the file names are.
 */
import { manifestLengthPrefix } from "./constants.ts"
import { FormatError } from "./errors.ts"

export interface ManifestFile {
  /** A `/`-separated relative path. */
  readonly name: string
  readonly size: number
  /** An IANA media type, or the empty string when unknown. */
  readonly mediaType: string
}

export interface Manifest {
  readonly version: 1
  readonly files: ReadonlyArray<ManifestFile>
  readonly totalSize: number
}

const invalid = (message: string): never => {
  throw new FormatError("invalid-manifest", message)
}

/**
 * A safe relative name: non-empty `/`-separated segments, none of them `.` or `..`, and no backslash or control
 * character. Receivers apply their own platform rules (reserved names, length limits) on top.
 */
const isForbiddenCharacter = (code: number) => code <= 0x1f || code === 0x7f || code === 0x5c

export const isSafeRelativeName = (name: string): boolean =>
  name.length > 0 &&
  !Array.from(name).some((character) => isForbiddenCharacter(character.codePointAt(0) ?? 0)) &&
  name.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const hasExactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>) => {
  const present = Object.keys(value).sort()
  return present.length === keys.length && [...keys].sort().every((key, index) => present[index] === key)
}

const validateFile = (value: unknown): ManifestFile => {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "size", "mediaType"])) return invalid("a file entry must have exactly name, size and mediaType")
  const { name, size, mediaType } = value
  if (typeof name !== "string" || !isSafeRelativeName(name)) return invalid("a file name is not a safe relative path")
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return invalid("a file size must be a non-negative safe integer")
  if (typeof mediaType !== "string") return invalid("a media type must be a string")
  return { name, size, mediaType }
}

/** Checks a decoded value against the v1 manifest shape, strictly: unknown fields are rejected. */
export const validateManifest = (value: unknown): Manifest => {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "files", "totalSize"])) return invalid("a manifest must have exactly version, files and totalSize")
  if (value["version"] !== 1) return invalid("manifest version must be 1")
  const filesValue = value["files"]
  if (!Array.isArray(filesValue)) return invalid("files must be an array")
  const files = filesValue.map(validateFile)
  if (new Set(files.map((file) => file.name)).size !== files.length) return invalid("file names must be unique")
  const sum = files.reduce((total, file) => total + file.size, 0)
  if (!Number.isSafeInteger(sum) || value["totalSize"] !== sum) return invalid("totalSize must equal the sum of the file sizes")
  return { version: 1, files, totalSize: sum }
}

/** Builds a manifest from file entries, computing `totalSize`. */
export const createManifest = (files: ReadonlyArray<ManifestFile>): Manifest =>
  validateManifest({
    version: 1,
    files: files.map(({ name, size, mediaType }) => ({ name, size, mediaType })),
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
  })

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true })

export const encodeManifestPlaintext = (manifest: Manifest, recordSize: number): Uint8Array<ArrayBuffer> => {
  const json = textEncoder.encode(JSON.stringify(validateManifest(manifest)))
  if (manifestLengthPrefix + json.length > recordSize) throw new FormatError("invalid-manifest", "the manifest does not fit in one record")
  const plaintext = new Uint8Array(recordSize)
  new DataView(plaintext.buffer).setUint32(0, json.length)
  plaintext.set(json, manifestLengthPrefix)
  return plaintext
}

export const decodeManifestPlaintext = (plaintext: Uint8Array): Manifest => {
  if (plaintext.length < manifestLengthPrefix) return invalid("the manifest record is too short")
  const length = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(0)
  const end = manifestLengthPrefix + length
  if (end > plaintext.length) return invalid("the manifest length exceeds the record")
  if (plaintext.subarray(end).some((byte) => byte !== 0)) return invalid("manifest padding must be zero bytes")
  let value: unknown
  try {
    value = JSON.parse(textDecoder.decode(plaintext.subarray(manifestLengthPrefix, end)))
  } catch {
    return invalid("the manifest is not UTF-8 JSON")
  }
  return validateManifest(value)
}
