// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/** The 54-byte plaintext header (docs/parcel.md, "Header"). */
import { bytesEqual } from "./bytes.ts"
import { parcelVersion, headerLength, headerMagic, isRecordSizeExponent, keyCommitmentLength, saltLength } from "./constants.ts"
import { ParcelError } from "./errors.ts"

export interface Header {
  readonly recordSizeExponent: number
  readonly salt: Uint8Array<ArrayBuffer>
  readonly keyCommitment: Uint8Array<ArrayBuffer>
  /** The exact 54 bytes, used as associated data of every record. */
  readonly bytes: Uint8Array<ArrayBuffer>
}

const saltOffset = 6
const keyCommitmentOffset = saltOffset + saltLength

export const encodeHeader = (fields: { readonly recordSizeExponent: number; readonly salt: Uint8Array; readonly keyCommitment: Uint8Array }): Header => {
  if (!isRecordSizeExponent(fields.recordSizeExponent)) throw new ParcelError("invalid-record-size", "record size exponent is out of range")
  if (fields.salt.length !== saltLength || fields.keyCommitment.length !== keyCommitmentLength) {
    throw new ParcelError("invalid-argument", "salt must be 16 bytes and key commitment 32 bytes")
  }
  const bytes = new Uint8Array(headerLength)
  bytes.set(headerMagic, 0)
  bytes[4] = parcelVersion
  bytes[5] = fields.recordSizeExponent
  bytes.set(fields.salt, saltOffset)
  bytes.set(fields.keyCommitment, keyCommitmentOffset)
  return decodeHeader(bytes)
}

/** Parses and range-checks a header. It does not check the key commitment, which needs the secret. */
export const decodeHeader = (input: Uint8Array): Header => {
  if (input.length !== headerLength) throw new ParcelError("invalid-header", `header must be ${headerLength} bytes`)
  const bytes = new Uint8Array(input)
  if (!bytesEqual(bytes.subarray(0, 4), headerMagic)) throw new ParcelError("invalid-header", "not an encrypted transfer (magic mismatch)")
  if (bytes[4] !== parcelVersion) throw new ParcelError("unsupported-version", `parcel version ${bytes[4]} is not supported`)
  const recordSizeExponent = bytes[5] ?? 0
  if (!isRecordSizeExponent(recordSizeExponent)) throw new ParcelError("invalid-record-size", "record size exponent is out of range")
  return {
    recordSizeExponent,
    salt: bytes.slice(saltOffset, keyCommitmentOffset),
    keyCommitment: bytes.slice(keyCommitmentOffset, headerLength),
    bytes,
  }
}
