// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/** The numbers docs/parcel.md fixes. Nothing else in the repository hard-codes them. */
import { ParcelError } from "./errors.ts"

export const parcelVersion = 1

/** Magic bytes at the start of every header. */
export const headerMagic = new Uint8Array([0x45, 0x32, 0x45, 0x01])

export const headerLength = 54
export const saltLength = 16
export const keyCommitmentLength = 32
export const secretLength = 32
export const authenticationTagLength = 16
export const nonceLength = 12

export const defaultRecordSizeExponent = 16
export const minimumRecordSizeExponent = 12
export const maximumRecordSizeExponent = 22

/** The manifest plaintext starts with its JSON length as a 4-byte big-endian integer. */
export const manifestLengthPrefix = 4

/** Trailer plaintext: 8-byte record count and 32-byte Merkle root. */
export const trailerPlaintextLength = 40
export const trailerCiphertextLength = trailerPlaintextLength + authenticationTagLength

export const derivationInfo = {
  roomToken: "e2e-transfer/v1/room-token",
  contentKey: "e2e-transfer/v1/content",
  manifestKey: "e2e-transfer/v1/manifest",
  keyCommitment: "e2e-transfer/v1/commitment",
} as const

export const isRecordSizeExponent = (exponent: number): boolean =>
  Number.isInteger(exponent) && exponent >= minimumRecordSizeExponent && exponent <= maximumRecordSizeExponent

export const recordSize = (exponent: number): number => {
  if (!isRecordSizeExponent(exponent)) {
    throw new ParcelError("invalid-record-size", `record size exponent must be an integer from ${minimumRecordSizeExponent} to ${maximumRecordSizeExponent}`)
  }
  return 2 ** exponent
}

/** Data records for `totalSize` bytes: full records, then one final record that may be shorter; an empty transfer has one empty record. */
export const dataRecordCount = (totalSize: number, size: number): number => Math.max(1, Math.ceil(totalSize / size))

/** Plaintext length of data record `index` in a transfer of `totalSize` bytes. */
export const dataPlaintextLength = (index: number, totalSize: number, size: number): number => {
  const count = dataRecordCount(totalSize, size)
  if (!Number.isSafeInteger(index) || index < 0 || index >= count)
    throw new ParcelError("invalid-argument", `record index ${index} is outside 0 to ${count - 1}`)
  return index < count - 1 ? size : totalSize - (count - 1) * size
}
