// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/**
 * The link secret and every key derived from it (docs/parcel.md, "Key derivation"): one HKDF-SHA-256 extraction
 * with salt "parcel/v1", then one expansion per output. Web Crypto's HKDF with that salt computes exactly
 * `expand(info)` for a 256-bit output.
 */
import { asBufferSource, concatBytes, decodeBase64Url, encodeBase64Url, toHex } from "./bytes.ts"
import { derivationInfo, derivationSalt, keyCommitmentLength, saltLength, secretLength, sequenceLimit } from "./constants.ts"
import { ParcelError } from "./errors.ts"

const textEncoder = new TextEncoder()

/** The keys of one record stream: AES-256-GCM for sealing, HMAC-SHA-256 for synthetic nonces. */
export interface StreamKeys {
  readonly aeadKey: CryptoKey
  readonly syntheticKey: CryptoKey
}

export interface ParcelKeys {
  readonly content: StreamKeys
  readonly manifest: StreamKeys
  readonly keyCommitment: Uint8Array<ArrayBuffer>
}

const requireLength = (bytes: Uint8Array, length: number, reason: "invalid-secret" | "invalid-argument", name: string) => {
  if (bytes.length !== length) throw new ParcelError(reason, `${name} must be ${length} bytes`)
}

/** A fresh 32-byte link secret. */
export const createSecret = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(secretLength))

/** A fresh 16-byte per-parcel salt. */
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

const hkdf = (info: Uint8Array) => ({ name: "HKDF", hash: "SHA-256", salt: textEncoder.encode(derivationSalt), info: asBufferSource(info) })

const infoFor = (label: string, salt?: Uint8Array) => (salt === undefined ? textEncoder.encode(label) : concatBytes(textEncoder.encode(label), salt))

/** Derives the room token from the link secret. */
export const deriveRoomToken = async (secret: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
  const material = await importSecret(secret)
  return new Uint8Array(await crypto.subtle.deriveBits(hkdf(infoFor(derivationInfo.roomToken)), material, 256))
}

/** The only form of the room token a server ever stores: its SHA-256, hex encoded. */
export const hashRoomToken = async (roomToken: Uint8Array): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", asBufferSource(roomToken))))

/** The secret parcel `sequence` of a room seals under: `expand(linkSecret, "parcel/v1/parcel-secret" || u32(sequence))`. */
export const deriveParcelSecret = async (linkSecret: Uint8Array, sequence: number): Promise<Uint8Array<ArrayBuffer>> => {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= sequenceLimit) throw new ParcelError("invalid-argument", "sequence must be a u32")
  const material = await importSecret(linkSecret)
  const sequenceBytes = new Uint8Array(4)
  new DataView(sequenceBytes.buffer).setUint32(0, sequence)
  return new Uint8Array(await crypto.subtle.deriveBits(hkdf(infoFor(derivationInfo.parcelSecret, sequenceBytes)), material, 256))
}

/** Every key of one parcel, non-extractable, and its key commitment, from the parcel secret and the header's salt. */
export const deriveParcelKeys = async (parcelSecret: Uint8Array, salt: Uint8Array): Promise<ParcelKeys> => {
  requireLength(salt, saltLength, "invalid-argument", "salt")
  const material = await importSecret(parcelSecret)
  const aes = { name: "AES-GCM", length: 256 }
  const hmac = { name: "HMAC", hash: "SHA-256", length: 256 }
  const [contentKey, contentSyntheticKey, manifestKey, manifestSyntheticKey, keyCommitment] = await Promise.all([
    crypto.subtle.deriveKey(hkdf(infoFor(derivationInfo.contentKey, salt)), material, aes, false, ["encrypt", "decrypt"]),
    crypto.subtle.deriveKey(hkdf(infoFor(derivationInfo.contentSyntheticKey, salt)), material, hmac, false, ["sign"]),
    crypto.subtle.deriveKey(hkdf(infoFor(derivationInfo.manifestKey, salt)), material, aes, false, ["encrypt", "decrypt"]),
    crypto.subtle.deriveKey(hkdf(infoFor(derivationInfo.manifestSyntheticKey, salt)), material, hmac, false, ["sign"]),
    crypto.subtle.deriveBits(hkdf(infoFor(derivationInfo.keyCommitment, salt)), material, keyCommitmentLength * 8),
  ])
  return {
    content: { aeadKey: contentKey, syntheticKey: contentSyntheticKey },
    manifest: { aeadKey: manifestKey, syntheticKey: manifestSyntheticKey },
    keyCommitment: new Uint8Array(keyCommitment),
  }
}
