// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/**
 * The manifest (docs/parcel.md, "Manifest"): what the parcel contains, in one canonical JSON form. Receivers
 * parse, validate, re-encode, and accept only if the re-encoding equals the bytes received, so every
 * implementation has the same accept set.
 */
import { bytesEqual } from "./bytes.ts"
import { manifestLengthPrefix, manifestRecordCount, manifestRecordSize, maximumManifestJsonLength, totalSizeLimit } from "./constants.ts"
import { ParcelError } from "./errors.ts"
import { nameCollision, nameProblem } from "./names.ts"

export interface ManifestFile {
  /** A `/`-separated relative path that follows the name profile. */
  readonly name: string
  readonly size: number
  /** A lowercase RFC 6838 media type, or the empty string when unknown. */
  readonly mediaType: string
}

export interface Manifest {
  readonly version: 1
  readonly files: ReadonlyArray<ManifestFile>
  readonly totalSize: number
}

const invalid = (message: string): never => {
  throw new ParcelError("invalid-manifest", message)
}

const restrictedName = "[a-z0-9][a-z0-9!#$&^_.+-]{0,126}"
const mediaTypePattern = new RegExp(`^${restrictedName}/${restrictedName}$`)

/** The empty string, or `type/subtype` per RFC 6838 section 4.2, lowercase ASCII, at most 127 bytes, no parameters. */
export const isValidMediaType = (mediaType: string): boolean => mediaType === "" || (mediaType.length <= 127 && mediaTypePattern.test(mediaType))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const hasExactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>) => {
  const present = Object.keys(value).sort()
  return present.length === keys.length && [...keys].sort().every((key, index) => present[index] === key)
}

const validateFile = (value: unknown): ManifestFile => {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "size", "mediaType"])) return invalid("a file entry must have exactly name, size and mediaType")
  const { name, size, mediaType } = value
  if (typeof name !== "string") return invalid("a file name must be a string")
  const problem = nameProblem(name)
  if (problem !== undefined) return invalid(`a file name ${problem}`)
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return invalid("a file size must be a non-negative integer")
  if (typeof mediaType !== "string" || !isValidMediaType(mediaType)) return invalid("a media type must be empty or a lowercase type/subtype")
  return { name, size, mediaType }
}

/** Checks a decoded value against the v1 manifest rules: shape, sizes, names, media types, uniqueness. */
export const validateManifest = (value: unknown): Manifest => {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "files", "totalSize"])) return invalid("a manifest must have exactly version, files and totalSize")
  if (value["version"] !== 1) return invalid("manifest version must be 1")
  const filesValue = value["files"]
  if (!Array.isArray(filesValue) || filesValue.length === 0) return invalid("files must be a non-empty array")
  const files = filesValue.map(validateFile)
  const collision = nameCollision(files.map((file) => file.name))
  if (collision !== undefined) return invalid(collision)
  const sum = files.reduce((total, file) => total + file.size, 0)
  if (!Number.isSafeInteger(sum) || sum >= totalSizeLimit || value["totalSize"] !== sum)
    return invalid("totalSize must equal the sum of the file sizes and be below 2^40")
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
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** The canonical JSON bytes: fixed key order, no whitespace, `JSON.stringify` escaping. */
export const encodeManifestJson = (manifest: Manifest): Uint8Array<ArrayBuffer> => {
  const valid = validateManifest(manifest)
  const canonical = {
    version: valid.version,
    files: valid.files.map(({ name, size, mediaType }) => ({ name, size, mediaType })),
    totalSize: valid.totalSize,
  }
  return textEncoder.encode(JSON.stringify(canonical))
}

/** Parses, validates and requires the bytes to be the canonical encoding of what they parse to. */
export const decodeManifestJson = (bytes: Uint8Array): Manifest => {
  let value: unknown
  try {
    value = JSON.parse(textDecoder.decode(bytes))
  } catch {
    return invalid("the manifest is not UTF-8 JSON")
  }
  const manifest = validateManifest(value)
  if (!bytesEqual(encodeManifestJson(manifest), bytes)) return invalid("the manifest is not in canonical form")
  return manifest
}

/** What the sealed contract promises besides the manifest: the data record count and the root over their labels. */
export interface ContractTerms {
  readonly recordCount: number
  readonly rootHash: Uint8Array
}

/** The manifest stream plaintext: u64 record count, root, u32 JSON length, canonical JSON, zero padding to a power-of-two number of 4 KiB records. */
export const encodeManifestStream = (manifest: Manifest, terms: ContractTerms): Uint8Array<ArrayBuffer> => {
  const json = encodeManifestJson(manifest)
  if (json.length > maximumManifestJsonLength) return invalid("the manifest is too large")
  if (terms.rootHash.length !== 32) throw new ParcelError("invalid-argument", "the root is 32 bytes")
  const plaintext = new Uint8Array(manifestRecordCount(json.length) * manifestRecordSize)
  const view = new DataView(plaintext.buffer)
  view.setBigUint64(0, BigInt(terms.recordCount))
  plaintext.set(terms.rootHash, 8)
  view.setUint32(40, json.length)
  plaintext.set(json, manifestLengthPrefix)
  return plaintext
}

/** The JSON length a first manifest record announces, checked against the limit. */
export const manifestJsonLength = (firstRecordPlaintext: Uint8Array): number => {
  if (firstRecordPlaintext.length !== manifestRecordSize) return invalid("a manifest record must hold 4096 bytes")
  const length = new DataView(firstRecordPlaintext.buffer, firstRecordPlaintext.byteOffset, firstRecordPlaintext.byteLength).getUint32(40)
  if (length > maximumManifestJsonLength) return invalid("the manifest length exceeds the limit")
  return length
}

export interface DecodedContract {
  readonly manifest: Manifest
  readonly recordCount: number
  readonly rootHash: Uint8Array<ArrayBuffer>
}

/** Decodes the whole manifest stream plaintext: its length must be the minimal record count, and the padding zero. */
export const decodeManifestStream = (plaintext: Uint8Array): DecodedContract => {
  const length = manifestJsonLength(plaintext.subarray(0, manifestRecordSize))
  if (plaintext.length !== manifestRecordCount(length) * manifestRecordSize) return invalid("the manifest stream has the wrong number of records")
  const end = manifestLengthPrefix + length
  if (plaintext.subarray(end).some((byte) => byte !== 0)) return invalid("manifest padding must be zero bytes")
  const count = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getBigUint64(0)
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new ParcelError("record-count-mismatch", "the record count is out of range")
  return { manifest: decodeManifestJson(plaintext.subarray(manifestLengthPrefix, end)), recordCount: Number(count), rootHash: plaintext.slice(8, 40) }
}
