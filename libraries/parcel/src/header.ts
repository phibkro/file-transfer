// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/** The 58-byte plaintext header (docs/parcel.md, "Header"). */
import { bytesEqual } from "./bytes.ts"
import { headerLength, headerMagic, isRecordSizeExponent, keyCommitmentLength, parcelVersion, saltLength, sequenceLimit } from "./constants.ts"
import { ParcelError } from "./errors.ts"

export interface Header {
  readonly recordSizeExponent: number
  /** The parcel's sequence number in its room; it selects the parcel secret. */
  readonly sequence: number
  readonly salt: Uint8Array<ArrayBuffer>
  readonly keyCommitment: Uint8Array<ArrayBuffer>
  /** The exact 58 bytes, used as associated data of every record. */
  readonly bytes: Uint8Array<ArrayBuffer>
}

const sequenceOffset = 6
const saltOffset = 10
const keyCommitmentOffset = saltOffset + saltLength

export const isSequence = (sequence: number): boolean => Number.isSafeInteger(sequence) && sequence >= 0 && sequence < sequenceLimit

export const encodeHeader = (fields: {
  readonly recordSizeExponent: number
  readonly sequence: number
  readonly salt: Uint8Array
  readonly keyCommitment: Uint8Array
}): Header => {
  if (!isRecordSizeExponent(fields.recordSizeExponent)) {
    throw new ParcelError("invalid-record-size", "record size exponent is out of range")
  }

  if (!isSequence(fields.sequence)) {
    throw new ParcelError("invalid-argument", "sequence must be a u32")
  }

  if (fields.salt.length !== saltLength || fields.keyCommitment.length !== keyCommitmentLength) {
    throw new ParcelError("invalid-argument", "salt must be 16 bytes and key commitment 32 bytes")
  }

  const bytes = new Uint8Array(headerLength)
  bytes.set(headerMagic, 0)
  bytes[4] = parcelVersion
  bytes[5] = fields.recordSizeExponent
  new DataView(bytes.buffer).setUint32(sequenceOffset, fields.sequence)
  bytes.set(fields.salt, saltOffset)
  bytes.set(fields.keyCommitment, keyCommitmentOffset)

  return decodeHeader(bytes)
}

/** Parses and range-checks a header. It does not check the key commitment, which needs the secret. */
export const decodeHeader = (input: Uint8Array): Header => {
  if (input.length !== headerLength) {
    throw new ParcelError("invalid-header", `header must be ${headerLength} bytes`)
  }

  const bytes = new Uint8Array(input)

  if (!bytesEqual(bytes.subarray(0, 4), headerMagic)) {
    throw new ParcelError("invalid-header", "not a parcel (magic mismatch)")
  }

  if (bytes[4] !== parcelVersion) {
    throw new ParcelError("unsupported-version", `parcel version ${bytes[4]} is not supported`)
  }

  const recordSizeExponent = bytes[5] ?? 0

  if (!isRecordSizeExponent(recordSizeExponent)) {
    throw new ParcelError("invalid-record-size", "record size exponent is out of range")
  }

  return {
    recordSizeExponent,
    sequence: new DataView(bytes.buffer).getUint32(sequenceOffset),
    salt: bytes.slice(saltOffset, keyCommitmentOffset),
    keyCommitment: bytes.slice(keyCommitmentOffset, headerLength),
    bytes,
  }
}
