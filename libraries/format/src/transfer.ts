// oxlint-effect-plugin ignore-file:
// reason: the wire-format core is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/**
 * Sealing and opening records (docs/format.md, "Records"). These are the record-level operations that resume and the
 * transport build on; `streams.ts` composes them into whole transfers.
 *
 * Resume note: re-sealing record `i` with the same keys gives the same ciphertext only for the same plaintext. A sender
 * that cannot be sure the source bytes are unchanged must start a new transfer (new salt) instead of resuming, since
 * two different plaintexts under one key and nonce break AES-GCM.
 */
import { asBufferSource, bytesEqual } from "./bytes.ts"
import {
  authenticationTagLength,
  dataPlaintextLength,
  dataRecordCount,
  defaultRecordSizeExponent,
  nonceLength,
  recordSize,
  trailerPlaintextLength,
} from "./constants.ts"
import { FormatError } from "./errors.ts"
import { decodeHeader, encodeHeader, type Header } from "./header.ts"
import { createSalt, deriveTransferKeys } from "./keys.ts"
import { decodeManifestPlaintext, encodeManifestPlaintext, type Manifest, validateManifest } from "./manifest.ts"

/** 11-byte big-endian record counter followed by the final flag. */
export const recordNonce = (counter: number, isFinal: boolean): Uint8Array<ArrayBuffer> => {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new FormatError("invalid-argument", "record counter must be a non-negative safe integer")
  const nonce = new Uint8Array(nonceLength)
  new DataView(nonce.buffer).setBigUint64(3, BigInt(counter))
  nonce[11] = isFinal ? 0x01 : 0x00
  return nonce
}

const seal = async (key: CryptoKey, counter: number, isFinal: boolean, header: Header, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: recordNonce(counter, isFinal), additionalData: header.bytes, tagLength: 128 },
      key,
      asBufferSource(plaintext),
    ),
  )

const open = async (
  key: CryptoKey,
  counter: number,
  isFinal: boolean,
  header: Header,
  ciphertext: Uint8Array,
  what: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: recordNonce(counter, isFinal), additionalData: header.bytes, tagLength: 128 },
        key,
        asBufferSource(ciphertext),
      ),
    )
  } catch {
    throw new FormatError("authentication-failed", `${what} failed authentication`)
  }
}

export interface Trailer {
  readonly recordCount: number
  readonly rootHash: Uint8Array<ArrayBuffer>
}

/** Lengths a receiver needs to cut a byte stream into records. */
export interface TransferLayout {
  readonly header: Header
  readonly manifest: Manifest
  readonly recordSize: number
  readonly recordCount: number
  dataCiphertextLength(index: number): number
}

const layoutFor = (header: Header, manifest: Manifest) => {
  const size = recordSize(header.recordSizeExponent)
  return {
    header,
    manifest,
    recordSize: size,
    recordCount: dataRecordCount(manifest.totalSize, size),
    dataCiphertextLength: (index: number) => dataPlaintextLength(index, manifest.totalSize, size) + authenticationTagLength,
  }
}

/** Ciphertext length of the manifest record for a given header: one full record plus its tag. */
export const manifestCiphertextLength = (header: Header): number => recordSize(header.recordSizeExponent) + authenticationTagLength

export interface TransferEncryptor extends TransferLayout {
  sealManifest(): Promise<Uint8Array<ArrayBuffer>>
  /** Seals data record `index`; its plaintext must have exactly the length the layout gives. */
  sealData(index: number, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
  sealTrailer(trailer: { readonly recordCount: number; readonly rootHash: Uint8Array }): Promise<Uint8Array<ArrayBuffer>>
}

export interface EncryptorOptions {
  readonly secret: Uint8Array
  readonly manifest: Manifest
  readonly recordSizeExponent?: number
  /** Only for test vectors: a fixed salt. Real transfers take a fresh random salt. */
  readonly salt?: Uint8Array
}

export const createEncryptor = async (options: EncryptorOptions): Promise<TransferEncryptor> => {
  const manifest = validateManifest(options.manifest)
  const salt = options.salt ?? createSalt()
  const keys = await deriveTransferKeys(options.secret, salt)
  const header = encodeHeader({ recordSizeExponent: options.recordSizeExponent ?? defaultRecordSizeExponent, salt, keyCommitment: keys.keyCommitment })
  const layout = layoutFor(header, manifest)
  const manifestPlaintext = encodeManifestPlaintext(manifest, layout.recordSize)
  return {
    ...layout,
    sealManifest: () => seal(keys.manifestKey, 0, false, header, manifestPlaintext),
    sealData: async (index, plaintext) => {
      const expected = dataPlaintextLength(index, manifest.totalSize, layout.recordSize)
      if (plaintext.length !== expected) throw new FormatError("size-mismatch", `data record ${index} must hold ${expected} bytes, got ${plaintext.length}`)
      return seal(keys.contentKey, index, index === layout.recordCount - 1, header, plaintext)
    },
    sealTrailer: async ({ recordCount, rootHash }) => {
      if (rootHash.length !== 32) throw new FormatError("invalid-argument", "root hash must be 32 bytes")
      const plaintext = new Uint8Array(trailerPlaintextLength)
      new DataView(plaintext.buffer).setBigUint64(0, BigInt(recordCount))
      plaintext.set(rootHash, 8)
      return seal(keys.manifestKey, 1, true, header, plaintext)
    },
  }
}

export interface TransferDecryptor extends TransferLayout {
  /** Opens data record `index` and checks its length; the final flag is implied by the index. */
  openData(index: number, ciphertext: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
  openTrailer(ciphertext: Uint8Array): Promise<Trailer>
}

/** Checks the header and key commitment, then opens the manifest. Any failure rejects before a byte of data is released. */
export const openTransfer = async (secret: Uint8Array, headerBytes: Uint8Array, manifestCiphertext: Uint8Array): Promise<TransferDecryptor> => {
  const header = decodeHeader(headerBytes)
  const keys = await deriveTransferKeys(secret, header.salt)
  if (!bytesEqual(keys.keyCommitment, header.keyCommitment)) throw new FormatError("key-commitment-mismatch", "the secret does not match this transfer")
  if (manifestCiphertext.length !== manifestCiphertextLength(header)) throw new FormatError("size-mismatch", "the manifest record has the wrong length")
  const manifest = decodeManifestPlaintext(await open(keys.manifestKey, 0, false, header, manifestCiphertext, "the manifest"))
  const layout = layoutFor(header, manifest)
  return {
    ...layout,
    openData: async (index, ciphertext) => {
      if (ciphertext.length !== layout.dataCiphertextLength(index)) throw new FormatError("size-mismatch", `data record ${index} has the wrong length`)
      return open(keys.contentKey, index, index === layout.recordCount - 1, header, ciphertext, `data record ${index}`)
    },
    openTrailer: async (ciphertext) => {
      if (ciphertext.length !== trailerPlaintextLength + authenticationTagLength) throw new FormatError("invalid-trailer", "the trailer has the wrong length")
      const plaintext = await open(keys.manifestKey, 1, true, header, ciphertext, "the trailer")
      const recordCount = new DataView(plaintext.buffer).getBigUint64(0)
      if (recordCount > BigInt(Number.MAX_SAFE_INTEGER)) throw new FormatError("invalid-trailer", "record count is out of range")
      return { recordCount: Number(recordCount), rootHash: plaintext.slice(8) }
    },
  }
}
