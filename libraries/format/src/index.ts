// oxlint-effect-plugin ignore-file:
// reason: the wire-format core is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/**
 * Encrypted object format v1. Specification: docs/format.md.
 *
 * Milestone M1 implements key derivation, records, manifest and trailer here.
 * Until then this module holds the constants the spec fixes and the room-token
 * helpers that services need, so nothing else hard-codes them.
 */

export const formatVersion = 1

/** Magic bytes at the start of every header. */
export const headerMagic = new Uint8Array([0x45, 0x32, 0x45, 0x01])

export const headerLength = 54
export const saltLength = 16
export const keyCommitmentLength = 32
export const secretLength = 32
export const authenticationTagLength = 16

export const defaultRecordSizeExponent = 16
export const minimumRecordSizeExponent = 12
export const maximumRecordSizeExponent = 22

export const derivationInfo = {
  roomToken: "e2e-transfer/v1/room-token",
  contentKey: "e2e-transfer/v1/content",
  manifestKey: "e2e-transfer/v1/manifest",
  keyCommitment: "e2e-transfer/v1/commitment",
} as const

export const recordSize = (exponent: number): number => {
  if (!Number.isInteger(exponent) || exponent < minimumRecordSizeExponent || exponent > maximumRecordSizeExponent) {
    throw new RangeError(`record size exponent must be an integer from ${minimumRecordSizeExponent} to ${maximumRecordSizeExponent}`)
  }
  return 2 ** exponent
}

const textEncoder = new TextEncoder()

/** Derives the room token from the link secret (HKDF-SHA-256, empty salt). */
export const deriveRoomToken = async (secret: Uint8Array): Promise<Uint8Array> => {
  if (secret.length !== secretLength) throw new RangeError(`secret must be ${secretLength} bytes`)
  const material = await crypto.subtle.importKey("raw", new Uint8Array(secret), "HKDF", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: textEncoder.encode(derivationInfo.roomToken) },
    material,
    256,
  )
  return new Uint8Array(bits)
}

/** The only form of the room token a server ever stores: its SHA-256, hex encoded. */
export const hashRoomToken = async (roomToken: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(roomToken))
  return toHex(new Uint8Array(digest))
}

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/** Constant-time comparison for equal-length hex strings. */
export const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}
