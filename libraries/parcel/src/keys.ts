// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/** The link secret and every key derived from it (docs/parcel.md, "Key derivation"). */
import { asBufferSource, decodeBase64Url, encodeBase64Url, toHex } from "./bytes.ts"
import { derivationInfo, keyCommitmentLength, saltLength, secretLength } from "./constants.ts"
import { ParcelError } from "./errors.ts"

const textEncoder = new TextEncoder()

export interface TransferKeys {
  readonly contentKey: CryptoKey
  readonly manifestKey: CryptoKey
  readonly keyCommitment: Uint8Array<ArrayBuffer>
}

const requireLength = (bytes: Uint8Array, length: number, reason: "invalid-secret" | "invalid-argument", name: string) => {
  if (bytes.length !== length) throw new ParcelError(reason, `${name} must be ${length} bytes`)
}

/** A fresh 32-byte link secret. */
export const createSecret = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(secretLength))

/** A fresh 16-byte per-transfer salt. */
export const createSalt = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(saltLength))

/** The URL fragment form of a secret: unpadded base64url. */
export const encodeLinkSecret = (secret: Uint8Array): string => {
  requireLength(secret, secretLength, "invalid-secret", "secret")
  return encodeBase64Url(secret)
}

export const decodeLinkSecret = (fragment: string): Uint8Array<ArrayBuffer> => {
  let secret: Uint8Array<ArrayBuffer>
  try {
    secret = decodeBase64Url(fragment.startsWith("#") ? fragment.slice(1) : fragment)
  } catch {
    throw new ParcelError("invalid-secret", "the link fragment is not a valid secret")
  }
  requireLength(secret, secretLength, "invalid-secret", "secret")
  return secret
}

const importSecret = (secret: Uint8Array) => {
  requireLength(secret, secretLength, "invalid-secret", "secret")
  return crypto.subtle.importKey("raw", asBufferSource(secret), "HKDF", false, ["deriveBits", "deriveKey"])
}

const hkdf = (salt: Uint8Array, info: string) => ({ name: "HKDF", hash: "SHA-256", salt: asBufferSource(salt), info: textEncoder.encode(info) })

/** Derives the room token from the link secret (HKDF-SHA-256, empty salt). */
export const deriveRoomToken = async (secret: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
  const material = await importSecret(secret)
  return new Uint8Array(await crypto.subtle.deriveBits(hkdf(new Uint8Array(0), derivationInfo.roomToken), material, 256))
}

/** The only form of the room token a server ever stores: its SHA-256, hex encoded. */
export const hashRoomToken = async (roomToken: Uint8Array): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", asBufferSource(roomToken))))

/** Content key, manifest key (both non-extractable AES-256-GCM) and key commitment for one transfer. */
export const deriveTransferKeys = async (secret: Uint8Array, salt: Uint8Array): Promise<TransferKeys> => {
  requireLength(salt, saltLength, "invalid-argument", "salt")
  const material = await importSecret(secret)
  const aes = { name: "AES-GCM", length: 256 }
  const [contentKey, manifestKey, keyCommitment] = await Promise.all([
    crypto.subtle.deriveKey(hkdf(salt, derivationInfo.contentKey), material, aes, false, ["encrypt", "decrypt"]),
    crypto.subtle.deriveKey(hkdf(salt, derivationInfo.manifestKey), material, aes, false, ["encrypt", "decrypt"]),
    crypto.subtle.deriveBits(hkdf(salt, derivationInfo.keyCommitment), material, keyCommitmentLength * 8),
  ])
  return { contentKey, manifestKey, keyCommitment: new Uint8Array(keyCommitment) }
}
