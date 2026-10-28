// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/** Byte helpers with no dependencies. */
import { ParcelError } from "./errors.ts"

/** Web Crypto takes views over an ArrayBuffer; copy only when the input views something else (a SharedArrayBuffer). */
export const asBufferSource = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes)

export const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

/** Compares two byte arrays in time that depends only on their length. */
export const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return difference === 0
}

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

export const fromHex = (text: string): Uint8Array<ArrayBuffer> => {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) throw new ParcelError("invalid-argument", "hex must be lowercase pairs of 0-9a-f")
  const bytes = new Uint8Array(text.length / 2)
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
  return bytes
}

const base64UrlAlphabet = /^[A-Za-z0-9_-]*$/

/** Base64url without padding (RFC 4648 section 5), as used in the link fragment. */
export const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Strict decoding: rejects padding, other alphabets and non-canonical trailing bits. */
export const decodeBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  if (!base64UrlAlphabet.test(text) || text.length % 4 === 1) throw new ParcelError("invalid-argument", "not unpadded base64url")
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeBase64Url(bytes) !== text) throw new ParcelError("invalid-argument", "base64url is not canonical")
  return bytes
}
