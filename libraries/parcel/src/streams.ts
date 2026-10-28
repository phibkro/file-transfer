// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/**
 * Whole parcels as Web Streams with constant memory: one record buffer and an O(log n) Merkle frontier.
 * Encryption emits one chunk per unit (header, each manifest record, each data record, trailer), which is what
 * the transport frames. Decryption accepts any chunking and emits one plaintext chunk per data record.
 *
 * Output is provisional until the trailer verifies (docs/parcel.md, receiver rule 5): the decryption stream
 * closes only after the trailer checks out and errors on any failure, so a sink that commits on close and aborts
 * on error never exposes a forged or truncated file.
 */
import { bytesEqual } from "./bytes.ts"
import { headerLength, trailerRecordLength } from "./constants.ts"
import { ParcelError } from "./errors.ts"
import type { Manifest } from "./manifest.ts"
import { leafHash, MerkleFrontier } from "./merkle.ts"
import {
  createEncryptor,
  type EncryptorOptions,
  manifestRecordLength,
  openHeader,
  type OpenOptions,
  type ParcelDecryptor,
  type ParcelEncryptor,
  type ParcelOpener,
} from "./transfer.ts"

export interface EncryptionStream {
  readonly stream: TransformStream<Uint8Array, Uint8Array>
  readonly encryptor: ParcelEncryptor
}

/** Plaintext in (the files concatenated in manifest order, exactly `totalSize` bytes, any chunking), parcel bytes out. */
export const createEncryptionStream = async (options: EncryptorOptions): Promise<EncryptionStream> => {
  const encryptor = await createEncryptor(options)
  const { recordSize, recordCount, manifest } = encryptor
  const frontier = new MerkleFrontier()
  const buffer = new Uint8Array(recordSize)
  let filled = 0
  let nextIndex = 0
  let received = 0

  const sealNext = async (controller: TransformStreamDefaultController<Uint8Array>, length: number) => {
    const record = await encryptor.sealData(nextIndex, buffer.subarray(0, length))
    await frontier.append(record)
    controller.enqueue(record)
    nextIndex++
    filled = 0
  }

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    start: async (controller) => {
      controller.enqueue(encryptor.header.bytes.slice())
      for (const record of await encryptor.sealManifest()) controller.enqueue(record)
    },
    transform: async (chunk, controller) => {
      received += chunk.length
      if (received > manifest.totalSize) throw new ParcelError("size-mismatch", "more plaintext than the manifest declares")
      let offset = 0
      while (offset < chunk.length) {
        const taken = Math.min(recordSize - filled, chunk.length - offset)
        buffer.set(chunk.subarray(offset, offset + taken), filled)
        filled += taken
        offset += taken
        if (filled === recordSize) await sealNext(controller, recordSize)
      }
    },
    flush: async (controller) => {
      if (received !== manifest.totalSize) throw new ParcelError("size-mismatch", "less plaintext than the manifest declares")
      if (nextIndex < recordCount) await sealNext(controller, filled)
      controller.enqueue(await encryptor.sealTrailer({ recordCount, rootHash: await frontier.root() }))
    },
  })
  return { stream, encryptor }
}

export interface DecryptionStream {
  readonly stream: TransformStream<Uint8Array, Uint8Array>
  /** Resolves once the manifest is authenticated, before any data; rejects if the parcel fails first. */
  readonly manifest: Promise<Manifest>
}

type Unit =
  | { readonly kind: "header" }
  | { readonly kind: "manifest"; readonly counter: number }
  | { readonly kind: "data"; readonly index: number }
  | { readonly kind: "trailer" }
  | { readonly kind: "done" }

/**
 * Parcel bytes in, plaintext out. Every record is authenticated before its plaintext is emitted; the stream
 * errors with a `ParcelError` on any failure, and the caller must then discard what it wrote.
 */
export const createDecryptionStream = (secret: Uint8Array, options: OpenOptions = {}): DecryptionStream => {
  let resolveManifest: (manifest: Manifest) => void = () => {}
  let rejectManifest: (error: unknown) => void = () => {}
  const manifest = new Promise<Manifest>((resolve, reject) => {
    resolveManifest = resolve
    rejectManifest = reject
  })
  manifest.catch(() => {})

  const frontier = new MerkleFrontier()
  let opener: ParcelOpener | undefined
  let manifestPlaintexts: Array<Uint8Array> = []
  let manifestRecords = 1
  let decryptor: ParcelDecryptor | undefined
  let unit: Unit = { kind: "header" }
  let pending = new Uint8Array(headerLength)
  let filled = 0

  const unitLength = (current: Unit): number => {
    switch (current.kind) {
      case "header":
        return headerLength
      case "manifest":
        return manifestRecordLength
      case "data":
        return decryptor?.dataRecordLength(current.index) ?? 0
      case "trailer":
        return trailerRecordLength
      case "done":
        return 0
    }
  }

  const advance = (next: Unit) => {
    unit = next
    pending = new Uint8Array(unitLength(next))
    filled = 0
  }

  const complete = async (controller: TransformStreamDefaultController<Uint8Array>) => {
    switch (unit.kind) {
      case "header":
        opener = await openHeader(secret, pending, options)
        advance({ kind: "manifest", counter: 0 })
        return
      case "manifest": {
        if (opener === undefined) throw new ParcelError("invalid-argument", "manifest before the header")
        const plaintext = await opener.openManifestRecord(unit.counter, pending)
        if (unit.counter === 0) manifestRecords = opener.manifestRecordCountFrom(plaintext)
        manifestPlaintexts.push(plaintext)
        if (unit.counter + 1 < manifestRecords) {
          advance({ kind: "manifest", counter: unit.counter + 1 })
          return
        }
        decryptor = opener.acceptManifest(manifestPlaintexts)
        manifestPlaintexts = []
        resolveManifest(decryptor.manifest)
        advance({ kind: "data", index: 0 })
        return
      }
      case "data": {
        if (decryptor === undefined) throw new ParcelError("invalid-argument", "data before the manifest")
        const plaintext = await decryptor.openData(unit.index, pending)
        await frontier.appendLeafHash(await leafHash(pending))
        controller.enqueue(plaintext)
        advance(unit.index + 1 < decryptor.recordCount ? { kind: "data", index: unit.index + 1 } : { kind: "trailer" })
        return
      }
      case "trailer": {
        if (decryptor === undefined) throw new ParcelError("invalid-argument", "trailer before the manifest")
        const trailer = await decryptor.openTrailer(pending)
        if (trailer.recordCount !== decryptor.recordCount)
          throw new ParcelError("record-count-mismatch", "the trailer's record count does not match the manifest")
        if (!bytesEqual(trailer.rootHash, await frontier.root()))
          throw new ParcelError("root-hash-mismatch", "the trailer's root hash does not match the records")
        advance({ kind: "done" })
        return
      }
      case "done":
        return
    }
  }

  const fail = (error: unknown): never => {
    rejectManifest(error)
    throw error
  }

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform: async (chunk, controller) => {
      try {
        let offset = 0
        while (offset < chunk.length) {
          if (unit.kind === "done") throw new ParcelError("trailing-data", "bytes after the trailer")
          const taken = Math.min(pending.length - filled, chunk.length - offset)
          pending.set(chunk.subarray(offset, offset + taken), filled)
          filled += taken
          offset += taken
          if (filled === pending.length) await complete(controller)
        }
      } catch (error) {
        fail(error)
      }
    },
    flush: () => {
      if (unit.kind !== "done") fail(new ParcelError("truncated", "the parcel ended before its trailer"))
    },
  })
  return { stream, manifest }
}
