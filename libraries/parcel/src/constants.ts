// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/** The numbers docs/parcel.md fixes. Nothing else in the repository hard-codes them. */
import { ParcelError } from "./errors.ts"

export const parcelVersion = 1

/** Magic bytes at the start of every header. */
export const headerMagic = new Uint8Array([0x45, 0x32, 0x45, 0x01])

export const headerLength = 58
export const sequenceLength = 4
export const saltLength = 16
export const keyCommitmentLength = 32
export const secretLength = 32
export const authenticationTagLength = 16
export const nonceLength = 12

/** Bytes of the synthetic value sent in front of each record; the other 5 nonce bytes are the counter. */
export const syntheticLength = 7

/** Bytes a record adds to its plaintext: the synthetic prefix and the tag. */
export const recordOverhead = syntheticLength + authenticationTagLength

export const defaultRecordSizeExponent = 16
export const minimumRecordSizeExponent = 12
export const maximumRecordSizeExponent = 22

/** Plaintext bytes of every manifest record. */
export const manifestRecordSize = 4096

/** The manifest stream plaintext starts with the contract: u64 record count, 32-byte root, u32 JSON length. */
export const manifestLengthPrefix = 8 + 32 + 4

/** The longest canonical manifest JSON, so the manifest stream is at most 4096 records (16 MiB). */
export const maximumManifestJsonLength = 2 ** 24 - manifestLengthPrefix

/** Labels are 32-byte leaf hashes; a label page covers this many records. */
export const labelLength = 32
export const labelsPerPage = 1024

/** Sequence numbers are u32. */
export const sequenceLimit = 2 ** 32

/** Every record counter is below this (it fills 5 nonce bytes). */
export const counterLimit = 2 ** 40

/** `totalSize` is below this (1 TiB). */
export const totalSizeLimit = 2 ** 40

/** HKDF-Extract salt and the prefix of every Expand info string. */
export const derivationSalt = "parcel/v1"

export const derivationInfo = {
  roomToken: "parcel/v1/room-token",
  parcelSecret: "parcel/v1/parcel-secret",
  contentKey: "parcel/v1/content-key",
  contentSyntheticKey: "parcel/v1/content-synthetic-key",
  manifestKey: "parcel/v1/manifest-key",
  manifestSyntheticKey: "parcel/v1/manifest-synthetic-key",
  keyCommitment: "parcel/v1/key-commitment",
} as const

export const isRecordSizeExponent = (exponent: number): boolean =>
  Number.isInteger(exponent) && exponent >= minimumRecordSizeExponent && exponent <= maximumRecordSizeExponent

export const recordSize = (exponent: number): number => {
  if (!isRecordSizeExponent(exponent)) {
    throw new ParcelError("invalid-record-size", `record size exponent must be an integer from ${minimumRecordSizeExponent} to ${maximumRecordSizeExponent}`)
  }

  return 2 ** exponent
}

/** Data records for `totalSize` bytes: full records, then one final record that may be shorter; an empty parcel has one empty record. */
export const dataRecordCount = (totalSize: number, size: number): number => Math.max(1, Math.ceil(totalSize / size))

/** Plaintext length of data record `index` in a parcel of `totalSize` bytes. */
export const dataPlaintextLength = (index: number, totalSize: number, size: number): number => {
  const count = dataRecordCount(totalSize, size)

  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new ParcelError("invalid-argument", `record index ${index} is outside 0 to ${count - 1}`)
  }

  return index < count - 1 ? size : totalSize - (count - 1) * size
}

/** Manifest records for a canonical JSON of `jsonLength` bytes: the smallest power of two that holds the length prefix and the JSON. */
export const manifestRecordCount = (jsonLength: number): number => {
  if (!Number.isSafeInteger(jsonLength) || jsonLength < 0 || jsonLength > maximumManifestJsonLength) {
    throw new ParcelError("invalid-manifest", "the manifest is too large")
  }

  const needed = Math.ceil((manifestLengthPrefix + jsonLength) / manifestRecordSize)
  let count = 1

  while (count < needed) {
    count *= 2
  }

  return count
}
