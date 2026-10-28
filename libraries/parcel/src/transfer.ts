// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/**
 * Sealing and opening a parcel's records (docs/parcel.md, "Stream layout"). These are the operations resume and
 * the transport build on; `streams.ts` composes them into whole parcels.
 *
 * Resume: nonces are synthetic, so a sender may reseal any record with the parcel's own salt. Same plaintext,
 * same bytes; changed plaintext, a different nonce (never a reused one), caught by the trailer's root.
 */
import { bytesEqual, concatBytes } from "./bytes.ts"
import {
  dataPlaintextLength,
  dataRecordCount,
  defaultRecordSizeExponent,
  manifestRecordCount,
  manifestRecordSize,
  recordOverhead,
  recordSize,
  trailerPlaintextLength,
  trailerRecordLength,
} from "./constants.ts"
import { ParcelError } from "./errors.ts"
import { decodeHeader, encodeHeader, type Header } from "./header.ts"
import { createSalt, deriveParcelKeys, type ParcelKeys } from "./keys.ts"
import { decodeManifestStream, encodeManifestStream, manifestJsonLength, type Manifest, validateManifest } from "./manifest.ts"
import { openRecord, sealRecord } from "./records.ts"

export interface Trailer {
  readonly recordCount: number
  readonly rootHash: Uint8Array<ArrayBuffer>
}

/** Lengths a receiver needs to cut a byte stream into records. */
export interface ParcelLayout {
  readonly header: Header
  readonly manifest: Manifest
  readonly recordSize: number
  /** Data records `n`. */
  readonly recordCount: number
  /** Manifest records `m`; the trailer is counter `m` of the manifest stream. */
  readonly manifestRecordCount: number
  dataRecordLength(index: number): number
}

/** Bytes of every manifest record on the wire. */
export const manifestRecordLength = manifestRecordSize + recordOverhead

const layoutFor = (header: Header, manifest: Manifest, manifestRecords: number): ParcelLayout => {
  const size = recordSize(header.recordSizeExponent)
  return {
    header,
    manifest,
    recordSize: size,
    recordCount: dataRecordCount(manifest.totalSize, size),
    manifestRecordCount: manifestRecords,
    dataRecordLength: (index: number) => dataPlaintextLength(index, manifest.totalSize, size) + recordOverhead,
  }
}

const encodeTrailer = ({ recordCount, rootHash }: { readonly recordCount: number; readonly rootHash: Uint8Array }) => {
  if (rootHash.length !== 32) throw new ParcelError("invalid-argument", "root hash must be 32 bytes")
  const plaintext = new Uint8Array(trailerPlaintextLength)
  new DataView(plaintext.buffer).setBigUint64(0, BigInt(recordCount))
  plaintext.set(rootHash, 8)
  return plaintext
}

export interface ParcelEncryptor extends ParcelLayout {
  /** The manifest records, counters 0 to m - 1. */
  sealManifest(): Promise<ReadonlyArray<Uint8Array<ArrayBuffer>>>
  /** Seals data record `index`; its plaintext must have exactly the length the layout gives. */
  sealData(index: number, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
  sealTrailer(trailer: { readonly recordCount: number; readonly rootHash: Uint8Array }): Promise<Uint8Array<ArrayBuffer>>
}

export interface EncryptorOptions {
  readonly secret: Uint8Array
  readonly manifest: Manifest
  readonly recordSizeExponent?: number
  /** The parcel's salt when resuming it (or for test vectors). New parcels take a fresh random salt. */
  readonly salt?: Uint8Array
}

export const createEncryptor = async (options: EncryptorOptions): Promise<ParcelEncryptor> => {
  const manifest = validateManifest(options.manifest)
  const salt = options.salt ?? createSalt()
  const keys = await deriveParcelKeys(options.secret, salt)
  const header = encodeHeader({ recordSizeExponent: options.recordSizeExponent ?? defaultRecordSizeExponent, salt, keyCommitment: keys.keyCommitment })
  const manifestPlaintext = encodeManifestStream(manifest)
  const layout = layoutFor(header, manifest, manifestPlaintext.length / manifestRecordSize)
  return {
    ...layout,
    sealManifest: () =>
      Promise.all(
        Array.from({ length: layout.manifestRecordCount }, (_, counter) =>
          sealRecord(
            keys.manifest,
            header.bytes,
            { counter, isFinal: false },
            manifestPlaintext.subarray(counter * manifestRecordSize, (counter + 1) * manifestRecordSize),
          ),
        ),
      ),
    sealData: async (index, plaintext) => {
      const expected = dataPlaintextLength(index, manifest.totalSize, layout.recordSize)
      if (plaintext.length !== expected) throw new ParcelError("size-mismatch", `data record ${index} must hold ${expected} bytes, got ${plaintext.length}`)
      return sealRecord(keys.content, header.bytes, { counter: index, isFinal: index === layout.recordCount - 1 }, plaintext)
    },
    sealTrailer: (trailer) => sealRecord(keys.manifest, header.bytes, { counter: layout.manifestRecordCount, isFinal: true }, encodeTrailer(trailer)),
  }
}

export interface ParcelDecryptor extends ParcelLayout {
  /** Opens data record `index` and checks its length; the final flag is implied by the index. */
  openData(index: number, record: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
  openTrailer(record: Uint8Array): Promise<Trailer>
}

/** A header whose key commitment matched: the manifest records come next. */
export interface ParcelOpener {
  readonly header: Header
  /** Opens manifest record `counter` (4096 bytes of plaintext). */
  openManifestRecord(counter: number, record: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
  /** The manifest record count the first record's plaintext announces. */
  manifestRecordCountFrom(firstRecordPlaintext: Uint8Array): number
  /** Decodes the opened manifest records (all of them, in order) and returns the decryptor for the data. */
  acceptManifest(plaintexts: ReadonlyArray<Uint8Array>): ParcelDecryptor
}

export interface OpenOptions {
  /** A header already accepted for this link; any other header is rejected (one secret, one parcel). */
  readonly expectedHeader?: Uint8Array
}

/** Checks the header and key commitment before anything else is read (docs/parcel.md, receiver rule 1). */
export const openHeader = async (secret: Uint8Array, headerBytes: Uint8Array, options: OpenOptions = {}): Promise<ParcelOpener> => {
  const header = decodeHeader(headerBytes)
  const keys: ParcelKeys = await deriveParcelKeys(secret, header.salt)
  if (!bytesEqual(keys.keyCommitment, header.keyCommitment)) throw new ParcelError("key-commitment-mismatch", "the secret does not match this parcel")
  if (options.expectedHeader !== undefined && !bytesEqual(options.expectedHeader, header.bytes)) {
    throw new ParcelError("header-mismatch", "this link already received a different parcel")
  }
  return {
    header,
    openManifestRecord: (counter, record) => {
      if (record.length !== manifestRecordLength) throw new ParcelError("size-mismatch", "a manifest record has the wrong length")
      return openRecord(keys.manifest, header.bytes, { counter, isFinal: false }, record, `manifest record ${counter}`)
    },
    manifestRecordCountFrom: (firstRecordPlaintext) => manifestRecordCount(manifestJsonLength(firstRecordPlaintext)),
    acceptManifest: (plaintexts) => {
      const manifest = decodeManifestStream(concatBytes(...plaintexts))
      const layout = layoutFor(header, manifest, plaintexts.length)
      return {
        ...layout,
        openData: async (index, record) => {
          if (record.length !== layout.dataRecordLength(index)) throw new ParcelError("size-mismatch", `data record ${index} has the wrong length`)
          return openRecord(keys.content, header.bytes, { counter: index, isFinal: index === layout.recordCount - 1 }, record, `data record ${index}`)
        },
        openTrailer: async (record) => {
          if (record.length !== trailerRecordLength) throw new ParcelError("invalid-trailer", "the trailer has the wrong length")
          const plaintext = await openRecord(keys.manifest, header.bytes, { counter: layout.manifestRecordCount, isFinal: true }, record, "the trailer")
          const count = new DataView(plaintext.buffer).getBigUint64(0)
          if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new ParcelError("invalid-trailer", "record count is out of range")
          return { recordCount: Number(count), rootHash: plaintext.slice(8) }
        },
      }
    },
  }
}

/** Opens a header and all manifest records at once (for tests and stored parcels). */
export const openParcel = async (
  secret: Uint8Array,
  headerBytes: Uint8Array,
  manifestRecords: ReadonlyArray<Uint8Array>,
  options: OpenOptions = {},
): Promise<ParcelDecryptor> => {
  const opener = await openHeader(secret, headerBytes, options)
  const first = manifestRecords[0]
  if (first === undefined) throw new ParcelError("truncated", "no manifest records")
  const firstPlaintext = await opener.openManifestRecord(0, first)
  const count = opener.manifestRecordCountFrom(firstPlaintext)
  if (manifestRecords.length !== count) throw new ParcelError("invalid-manifest", "the manifest stream has the wrong number of records")
  const rest = await Promise.all(manifestRecords.slice(1).map((record, index) => opener.openManifestRecord(index + 1, record)))
  return opener.acceptManifest([firstPlaintext, ...rest])
}
