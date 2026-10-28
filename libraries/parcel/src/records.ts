// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/**
 * One record of either stream (docs/parcel.md, "Records"): AES-256-GCM with a synthetic nonce.
 *
 *   synthetic = HMAC(syntheticKey, u64(i) || u8(f) || P)
 *   nonce     = u40(i) || first(7, synthetic)
 *   aad       = header || u64(i) || u8(f)
 *   record    = first(7, synthetic) || AES-256-GCM(aeadKey, nonce, P, aad)
 *
 * The nonce depends on the plaintext, so resealing a record with changed plaintext never reuses a nonce, and
 * resealing it with the same plaintext gives the same bytes.
 */
import { asBufferSource, bytesEqual, concatBytes } from "./bytes.ts"
import { counterLimit, headerLength, nonceLength, recordOverhead, syntheticLength } from "./constants.ts"
import { ParcelError } from "./errors.ts"
import type { StreamKeys } from "./keys.ts"

const counterAndFlag = (counter: number, isFinal: boolean): Uint8Array<ArrayBuffer> => {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter >= counterLimit) {
    throw new ParcelError("invalid-argument", "record counter must be an integer from 0 to 2^40 - 1")
  }
  const bytes = new Uint8Array(9)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(counter))
  bytes[8] = isFinal ? 0x01 : 0x00
  return bytes
}

/** The 12-byte nonce: the counter as 5 big-endian bytes, then the 7 synthetic bytes. */
export const recordNonce = (counter: number, synthetic: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (synthetic.length !== syntheticLength) throw new ParcelError("invalid-argument", `the synthetic prefix is ${syntheticLength} bytes`)
  const nonce = new Uint8Array(nonceLength)
  const counterBytes = counterAndFlag(counter, false)
  nonce.set(counterBytes.subarray(3, 8), 0)
  nonce.set(synthetic, 5)
  return nonce
}

const syntheticFor = async (keys: StreamKeys, position: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.sign("HMAC", keys.syntheticKey, concatBytes(position, plaintext))).slice(0, syntheticLength)

export interface RecordPosition {
  readonly counter: number
  readonly isFinal: boolean
}

export const sealRecord = async (keys: StreamKeys, header: Uint8Array, position: RecordPosition, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
  if (header.length !== headerLength) throw new ParcelError("invalid-argument", `the header must be ${headerLength} bytes`)
  const positionBytes = counterAndFlag(position.counter, position.isFinal)
  const synthetic = await syntheticFor(keys, positionBytes, plaintext)
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: recordNonce(position.counter, synthetic), additionalData: concatBytes(header, positionBytes), tagLength: 128 },
    keys.aeadKey,
    asBufferSource(plaintext),
  )
  return concatBytes(synthetic, new Uint8Array(sealed))
}

/** Opens a record at a known position; the synthetic prefix must match the plaintext. */
export const openRecord = async (
  keys: StreamKeys,
  header: Uint8Array,
  position: RecordPosition,
  record: Uint8Array,
  what: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  if (record.length < recordOverhead) throw new ParcelError("size-mismatch", `${what} is too short`)
  const positionBytes = counterAndFlag(position.counter, position.isFinal)
  const synthetic = record.subarray(0, syntheticLength)
  let plaintext: Uint8Array<ArrayBuffer>
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: recordNonce(position.counter, synthetic), additionalData: concatBytes(header, positionBytes), tagLength: 128 },
        keys.aeadKey,
        asBufferSource(record.subarray(syntheticLength)),
      ),
    )
  } catch {
    throw new ParcelError("authentication-failed", `${what} failed authentication`)
  }
  if (!bytesEqual(await syntheticFor(keys, positionBytes, plaintext), synthetic)) {
    throw new ParcelError("authentication-failed", `${what} has a nonce that does not match its plaintext`)
  }
  return plaintext
}
