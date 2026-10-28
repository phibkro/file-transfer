// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/**
 * Whole parcels as Web Streams.
 *
 * Sending reads the source twice: the labelling pass seals every record and keeps its 32-byte label, then the
 * sending pass reseals each record (deterministically, so the bytes are the same) and checks it against its label,
 * stopping with `source-changed` if the source moved underneath. The stream emits the header, each manifest record,
 * then each label page followed by the records it covers.
 *
 * Receiving accepts any chunking and emits one plaintext chunk per data record. Output is provisional until the
 * last record verifies (docs/parcel.md, receiver rule 5): the stream closes only after the whole parcel checks out
 * and errors on any failure, so a sink that commits on close and aborts on error never exposes a forged, changed or
 * truncated file.
 */
import { bytesEqual } from "./bytes.ts"
import { headerLength, labelsPerPage } from "./constants.ts"
import { ParcelError } from "./errors.ts"
import type { Header } from "./header.ts"
import type { Manifest } from "./manifest.ts"
import { leafHash } from "./merkle.ts"
import { createParcelSealer, labelRecords, manifestRecordLength, openHeader } from "./transfer.ts"
import type { Contract, OpenOptions, ParcelOpener, ParcelReceiver, RecordReader, SealerOptions } from "./transfer.ts"

/** Reads records from bytes in memory. */
export const recordReaderFromBytes =
  (bytes: Uint8Array, recordSize: number): RecordReader =>
  async (index, length) =>
    bytes.subarray(index * recordSize, index * recordSize + length)

/** Reads records from a Blob or File without loading it whole. */
export const recordReaderFromBlob =
  (blob: Blob, recordSize: number): RecordReader =>
  async (index, length) =>
    new Uint8Array(await blob.slice(index * recordSize, index * recordSize + length).arrayBuffer())

export interface ParcelSender {
  readonly contract: Contract
  readonly stream: ReadableStream<Uint8Array>
}

export interface SenderOptions extends SealerOptions {
  readonly readRecord: RecordReader
  /**
   * When resuming after a reload, the contract digest stored for this sequence number. If relabelling the source
   * gives a different contract, the source changed: fail with `source-changed` and offer the files as a new contract
   * under the next sequence number (docs/parcel.md, sender rules).
   */
  readonly expectedDigest?: Uint8Array
}

/** Labels every record, seals the contract, and returns the stream that sends it (the labelling pass runs before this resolves). */
export const createParcelSender = async (options: SenderOptions): Promise<ParcelSender> => {
  const sealer = await createParcelSealer(options)
  const contract = await sealer.sealContract(await labelRecords(sealer, options.readRecord))

  if (options.expectedDigest !== undefined && !bytesEqual(options.expectedDigest, contract.digest)) {
    throw new ParcelError("source-changed", "relabelling gave a different contract than the one stored for this sequence number")
  }

  async function* units(): AsyncGenerator<Uint8Array> {
    yield contract.header.bytes.slice()

    for (const record of contract.manifestRecords) {
      yield record
    }

    for (let page = 0; page < contract.pageCount; page++) {
      yield await contract.labelPage(page)
      const { start, end } = contract.pageRecords(page)

      for (let index = start; index < end; index++) {
        const record = await sealer.sealData(index, await options.readRecord(index, sealer.dataPlaintextLength(index)))

        if (!bytesEqual(await leafHash(record), contract.labelOf(index))) {
          throw new ParcelError("source-changed", `data record ${index} changed since the contract was sealed`)
        }

        yield record
      }
    }
  }

  const iterator = units()

  const stream = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const next = await iterator.next()

      if (next.done) {
        controller.close()
      } else {
        controller.enqueue(next.value)
      }
    },
    cancel: async () => {
      await iterator.return(undefined)
    },
  })

  return { contract, stream }
}

/** What the receiver knows once the contract is open, before any content. */
export interface ReceivedContract {
  readonly header: Header
  readonly manifest: Manifest
  readonly recordCount: number
  readonly rootHash: Uint8Array
  readonly digest: Uint8Array
}

export interface DecryptionStream {
  readonly stream: TransformStream<Uint8Array, Uint8Array>
  /** Resolves once the contract is open, before any content; rejects if the parcel fails first. */
  readonly contract: Promise<ReceivedContract>
  readonly manifest: Promise<Manifest>
}

type Unit =
  | { readonly kind: "header" }
  | { readonly kind: "manifest"; readonly counter: number }
  | { readonly kind: "page"; readonly page: number }
  | { readonly kind: "data"; readonly index: number }
  | { readonly kind: "done" }

/**
 * Parcel bytes in, plaintext out. Every page is checked against the root and every record against its label
 * before its plaintext is emitted; the stream errors with a `ParcelError` on any failure (a breach names the
 * record), and the caller must then discard what it wrote.
 */
export const createDecryptionStream = (linkSecret: Uint8Array, options: OpenOptions = {}): DecryptionStream => {
  let resolveContract: (contract: ReceivedContract) => void = () => {}
  let rejectContract: (error: unknown) => void = () => {}

  const contract = new Promise<ReceivedContract>((resolve, reject) => {
    resolveContract = resolve
    rejectContract = reject
  })

  contract.catch(() => {})
  const manifest = contract.then((opened) => opened.manifest)
  manifest.catch(() => {})

  let opener: ParcelOpener | undefined
  let manifestPlaintexts: Uint8Array[] = []
  let manifestRecords: Uint8Array[] = []
  let manifestRecordTotal = 1
  let receiver: ParcelReceiver | undefined
  let pageLabelCount = 0
  let pageStart = 0
  let currentPage = 0
  let unit: Unit = { kind: "header" }
  let pending = new Uint8Array(headerLength)
  let filled = 0

  const unitLength = (current: Unit): number => {
    switch (current.kind) {
      case "header": {
        return headerLength
      }

      case "manifest": {
        return manifestRecordLength
      }

      case "page": {
        return receiver?.pageLength(current.page) ?? 0
      }

      case "data": {
        return receiver?.dataRecordLength(current.index) ?? 0
      }

      case "done": {
        return 0
      }
    }
  }

  const advance = (next: Unit) => {
    unit = next
    pending = new Uint8Array(unitLength(next))
    filled = 0
  }

  const complete = async (controller: TransformStreamDefaultController<Uint8Array>) => {
    switch (unit.kind) {
      case "header": {
        opener = await openHeader(linkSecret, pending, options)
        advance({ kind: "manifest", counter: 0 })

        return
      }

      case "manifest": {
        if (opener === undefined) {
          throw new ParcelError("invalid-argument", "manifest before the header")
        }

        const plaintext = await opener.openManifestRecord(unit.counter, pending)

        if (unit.counter === 0) {
          manifestRecordTotal = opener.manifestRecordCountFrom(plaintext)
        }

        manifestPlaintexts.push(plaintext)
        manifestRecords.push(pending)

        if (unit.counter + 1 < manifestRecordTotal) {
          advance({ kind: "manifest", counter: unit.counter + 1 })

          return
        }

        receiver = await opener.acceptContract(manifestPlaintexts, manifestRecords)
        manifestPlaintexts = []
        manifestRecords = []
        resolveContract({
          header: opener.header,
          manifest: receiver.manifest,
          recordCount: receiver.recordCount,
          rootHash: receiver.rootHash,
          digest: receiver.digest,
        })
        advance({ kind: "page", page: 0 })

        return
      }

      case "page": {
        if (receiver === undefined) {
          throw new ParcelError("invalid-argument", "page before the contract")
        }

        pageLabelCount = (await receiver.verifyPage(unit.page, pending)).length
        currentPage = unit.page
        pageStart = receiver.pageRecords(unit.page).start
        advance({ kind: "data", index: pageStart })

        return
      }

      case "data": {
        if (receiver === undefined) {
          throw new ParcelError("invalid-argument", "data before the contract")
        }

        controller.enqueue(await receiver.openData(unit.index, pending))
        const next = unit.index + 1

        if (next - pageStart >= pageLabelCount) {
          receiver.releasePage(currentPage)
        }

        if (next >= receiver.recordCount) {
          advance({ kind: "done" })
        } else if (next - pageStart >= pageLabelCount) {
          advance({ kind: "page", page: next / labelsPerPage })
        } else {
          advance({ kind: "data", index: next })
        }

        return
      }

      case "done": {
        return
      }
    }
  }

  const fail = (error: unknown): never => {
    rejectContract(error)
    throw error
  }

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform: async (chunk, controller) => {
      try {
        let offset = 0

        while (offset < chunk.length) {
          if (unit.kind === "done") {
            throw new ParcelError("trailing-data", "bytes after the last record")
          }

          const taken = Math.min(pending.length - filled, chunk.length - offset)
          pending.set(chunk.subarray(offset, offset + taken), filled)
          filled += taken
          offset += taken

          if (filled === pending.length) {
            await complete(controller)
          }
        }
      } catch (error) {
        fail(error)
      }
    },
    flush: () => {
      if (unit.kind !== "done") {
        fail(new ParcelError("truncated", "the parcel ended before its last record"))
      }
    },
  })

  return { stream, contract, manifest }
}
