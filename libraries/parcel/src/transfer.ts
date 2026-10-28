// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/**
 * Contract before content (docs/parcel.md, docs/decisions/0012). A sender seals and labels every data record, then
 * seals a contract (header and manifest stream with the record count and the root over the labels), then sends
 * label pages ahead of the records they cover. A receiver opens the contract before any content and checks every
 * page against the root and every record against its label.
 */
import { asBufferSource, bytesEqual, concatBytes } from "./bytes.ts"
import {
  dataPlaintextLength,
  dataRecordCount,
  defaultRecordSizeExponent,
  labelLength,
  labelsPerPage,
  manifestRecordCount,
  manifestRecordSize,
  recordOverhead,
  recordSize,
} from "./constants.ts"
import { ParcelError } from "./errors.ts"
import { decodeHeader, encodeHeader, type Header } from "./header.ts"
import { createSalt, deriveParcelKeys, deriveParcelSecret } from "./keys.ts"
import { decodeManifestStream, encodeManifestStream, manifestJsonLength, type Manifest, validateManifest } from "./manifest.ts"
import { auditPath, foldAuditPath, leafHash, treeHash } from "./merkle.ts"
import { openRecord, sealRecord } from "./records.ts"

/** Bytes of every manifest record on the wire. */
export const manifestRecordLength = manifestRecordSize + recordOverhead

/** Lengths and ranges a receiver needs to cut a parcel into units. */
export interface ParcelLayout {
  readonly header: Header
  readonly manifest: Manifest
  readonly recordSize: number
  /** Data records `n`. */
  readonly recordCount: number
  /** Manifest records `m`. */
  readonly manifestRecordCount: number
  /** Label pages `k`. */
  readonly pageCount: number
  dataRecordLength(index: number): number
  /** The data records page `page` covers: `start` to `end - 1`. */
  pageRecords(page: number): { readonly start: number; readonly end: number }
  /** Bytes of label page `page`: its labels and its audit path. */
  pageLength(page: number): number
}

const layoutFor = (header: Header, manifest: Manifest, manifestRecords: number): ParcelLayout => {
  const size = recordSize(header.recordSizeExponent)
  const count = dataRecordCount(manifest.totalSize, size)
  const pageCount = Math.ceil(count / labelsPerPage)
  const pageRecords = (page: number) => {
    if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) throw new ParcelError("invalid-argument", "page index out of range")
    return { start: page * labelsPerPage, end: Math.min(count, (page + 1) * labelsPerPage) }
  }
  return {
    header,
    manifest,
    recordSize: size,
    recordCount: count,
    manifestRecordCount: manifestRecords,
    pageCount,
    dataRecordLength: (index) => dataPlaintextLength(index, manifest.totalSize, size) + recordOverhead,
    pageRecords,
    pageLength: (page) => {
      const { start, end } = pageRecords(page)
      return labelLength * (end - start + auditPath(pageCount, page).length)
    },
  }
}

const labelAt = (labels: Uint8Array, index: number) => labels.subarray(index * labelLength, (index + 1) * labelLength)

const labelList = (labels: Uint8Array, start: number, end: number) => Array.from({ length: end - start }, (_, offset) => labelAt(labels, start + offset))

/** A sealed contract, ready to send: the header, the manifest records, and the label pages. */
export interface Contract extends ParcelLayout {
  readonly manifestRecords: ReadonlyArray<Uint8Array<ArrayBuffer>>
  readonly rootHash: Uint8Array<ArrayBuffer>
  /** `H(header || manifest records)`: what a recipient's acceptance names. */
  readonly digest: Uint8Array<ArrayBuffer>
  labelOf(index: number): Uint8Array
  labelPage(page: number): Promise<Uint8Array<ArrayBuffer>>
}

export interface SealerOptions {
  readonly linkSecret: Uint8Array
  /** The parcel's sequence number in its room; 0 for the first. */
  readonly sequence?: number
  readonly manifest: Manifest
  readonly recordSizeExponent?: number
  /** The parcel's salt when resuming it (or for test vectors). New parcels take a fresh random salt. */
  readonly salt?: Uint8Array
}

export interface ParcelSealer {
  readonly header: Header
  readonly manifest: Manifest
  readonly recordSize: number
  readonly recordCount: number
  dataPlaintextLength(index: number): number
  /** Seals data record `index`; its plaintext must have exactly the length the layout gives. Deterministic. */
  sealData(index: number, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
  /** Seals the contract over every record's label (`recordCount * 32` bytes, in order). */
  sealContract(labels: Uint8Array): Promise<Contract>
}

export const createParcelSealer = async (options: SealerOptions): Promise<ParcelSealer> => {
  const manifest = validateManifest(options.manifest)
  const sequence = options.sequence ?? 0
  const salt = options.salt ?? createSalt()
  const keys = await deriveParcelKeys(await deriveParcelSecret(options.linkSecret, sequence), salt)
  const header = encodeHeader({
    recordSizeExponent: options.recordSizeExponent ?? defaultRecordSizeExponent,
    sequence,
    salt,
    keyCommitment: keys.keyCommitment,
  })
  const size = recordSize(header.recordSizeExponent)
  const count = dataRecordCount(manifest.totalSize, size)
  return {
    header,
    manifest,
    recordSize: size,
    recordCount: count,
    dataPlaintextLength: (index) => dataPlaintextLength(index, manifest.totalSize, size),
    sealData: async (index, plaintext) => {
      const expected = dataPlaintextLength(index, manifest.totalSize, size)
      if (plaintext.length !== expected) throw new ParcelError("size-mismatch", `data record ${index} must hold ${expected} bytes, got ${plaintext.length}`)
      return sealRecord(keys.content, header.bytes, { counter: index, isFinal: index === count - 1 }, plaintext)
    },
    sealContract: async (labels) => {
      if (labels.length !== count * labelLength) throw new ParcelError("invalid-argument", "one 32-byte label per data record")
      const pageCount = Math.ceil(count / labelsPerPage)
      const pageRoots = await Promise.all(
        Array.from({ length: pageCount }, (_, page) => treeHash(labelList(labels, page * labelsPerPage, Math.min(count, (page + 1) * labelsPerPage)))),
      )
      const rootHash = await treeHash(pageRoots)
      const plaintext = encodeManifestStream(manifest, { recordCount: count, rootHash })
      const manifestRecords = await Promise.all(
        Array.from({ length: plaintext.length / manifestRecordSize }, (_, counter) =>
          sealRecord(
            keys.manifest,
            header.bytes,
            { counter, isFinal: false },
            plaintext.subarray(counter * manifestRecordSize, (counter + 1) * manifestRecordSize),
          ),
        ),
      )
      const layout = layoutFor(header, manifest, manifestRecords.length)
      return {
        ...layout,
        manifestRecords,
        rootHash,
        digest: new Uint8Array(await crypto.subtle.digest("SHA-256", concatBytes(header.bytes, ...manifestRecords))),
        labelOf: (index) => labelAt(labels, index),
        labelPage: async (page) => {
          const { start, end } = layout.pageRecords(page)
          const siblings = await Promise.all(auditPath(pageCount, page).map((sibling) => treeHash(pageRoots, sibling.start, sibling.end)))
          return concatBytes(labels.subarray(start * labelLength, end * labelLength), ...siblings)
        },
      }
    },
  }
}

/** Reads the plaintext of data record `index` (`length` bytes) from the source. */
export type RecordReader = (index: number, length: number) => Promise<Uint8Array>

/** The labelling pass: seals every record once and keeps only its label. */
export const labelRecords = async (sealer: ParcelSealer, readRecord: RecordReader): Promise<Uint8Array<ArrayBuffer>> => {
  const labels = new Uint8Array(sealer.recordCount * labelLength)
  for (let index = 0; index < sealer.recordCount; index++) {
    labels.set(await leafHash(await sealer.sealData(index, await readRecord(index, sealer.dataPlaintextLength(index)))), index * labelLength)
  }
  return labels
}

/** A contract the receiver has opened: layout, root, digest, and the checks for pages and records. */
export interface ParcelReceiver extends ParcelLayout {
  readonly rootHash: Uint8Array<ArrayBuffer>
  readonly digest: Uint8Array<ArrayBuffer>
  /** Checks label page `page` against the root, keeps its labels for `openData`, and returns them. */
  verifyPage(page: number, bytes: Uint8Array): Promise<ReadonlyArray<Uint8Array>>
  /**
   * Checks data record `index` against the label from its verified page, then opens it. Fails with
   * `label-page-missing` when that page has not verified yet: drop the record and request it again (receiver rule 6).
   */
  openData(index: number, record: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
  /** Forgets a page's labels once every record it covers is in, so a sequential receiver holds one page at a time. */
  releasePage(page: number): void
}

/** A header whose key commitment matched: the manifest records come next. */
export interface ParcelOpener {
  readonly header: Header
  openManifestRecord(counter: number, record: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
  /** The manifest record count the first record's plaintext announces. */
  manifestRecordCountFrom(firstRecordPlaintext: Uint8Array): number
  /** Decodes the contract from all opened manifest records (plaintexts and the records as received, in order). */
  acceptContract(plaintexts: ReadonlyArray<Uint8Array>, records: ReadonlyArray<Uint8Array>): Promise<ParcelReceiver>
}

export interface OpenOptions {
  /**
   * The contract digest already accepted for this sequence number. Any other contract is rejected with
   * `contract-mismatch` (a parcel secret seals exactly one parcel); pinning the header alone is not enough.
   */
  readonly expectedDigest?: Uint8Array
}

/** Checks the header and key commitment before anything else is read (docs/parcel.md, receiver rule 1). */
export const openHeader = async (linkSecret: Uint8Array, headerBytes: Uint8Array, options: OpenOptions = {}): Promise<ParcelOpener> => {
  const header = decodeHeader(headerBytes)
  const keys = await deriveParcelKeys(await deriveParcelSecret(linkSecret, header.sequence), header.salt)
  if (!bytesEqual(keys.keyCommitment, header.keyCommitment)) throw new ParcelError("key-commitment-mismatch", "the secret does not match this parcel")
  return {
    header,
    openManifestRecord: (counter, record) => {
      if (record.length !== manifestRecordLength) throw new ParcelError("size-mismatch", "a manifest record has the wrong length")
      return openRecord(keys.manifest, header.bytes, { counter, isFinal: false }, record, `manifest record ${counter}`)
    },
    manifestRecordCountFrom: (firstRecordPlaintext) => manifestRecordCount(manifestJsonLength(firstRecordPlaintext)),
    acceptContract: async (plaintexts, records) => {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", asBufferSource(concatBytes(header.bytes, ...records))))
      if (options.expectedDigest !== undefined && !bytesEqual(options.expectedDigest, digest)) {
        throw new ParcelError("contract-mismatch", `sequence number ${header.sequence} already has a different contract`)
      }
      const contract = decodeManifestStream(concatBytes(...plaintexts))
      const layout = layoutFor(header, contract.manifest, plaintexts.length)
      if (contract.recordCount !== layout.recordCount) throw new ParcelError("record-count-mismatch", "the contract's record count does not match the manifest")
      const verifiedPages = new Map<number, ReadonlyArray<Uint8Array>>()
      return {
        ...layout,
        rootHash: contract.rootHash,
        digest,
        verifyPage: async (page, bytes) => {
          const { start, end } = layout.pageRecords(page)
          const path = auditPath(layout.pageCount, page)
          if (bytes.length !== labelLength * (end - start + path.length)) throw new ParcelError("size-mismatch", `label page ${page} has the wrong length`)
          const labels = labelList(bytes, 0, end - start).map((label) => label.slice())
          const siblings = labelList(bytes, end - start, end - start + path.length)
          if (!bytesEqual(await foldAuditPath(await treeHash(labels), path, siblings), contract.rootHash)) {
            throw new ParcelError("label-page-mismatch", `label page ${page} does not belong to the contract's root`)
          }
          verifiedPages.set(page, labels)
          return labels
        },
        openData: async (index, record) => {
          if (record.length !== layout.dataRecordLength(index)) throw new ParcelError("size-mismatch", `data record ${index} has the wrong length`)
          const page = Math.floor(index / labelsPerPage)
          const label = verifiedPages.get(page)?.[index - page * labelsPerPage]
          if (label === undefined) throw new ParcelError("label-page-missing", `data record ${index} arrived before label page ${page} verified`)
          if (!bytesEqual(await leafHash(record), label)) throw new ParcelError("label-mismatch", `data record ${index} differs from the contract (breach)`)
          return openRecord(keys.content, header.bytes, { counter: index, isFinal: index === layout.recordCount - 1 }, record, `data record ${index}`)
        },
        releasePage: (page) => {
          verifiedPages.delete(page)
        },
      }
    },
  }
}
