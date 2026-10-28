/** Helpers for the parcel tests: send and receive whole parcels, and locate their units. */
import {
  auditPath,
  concatBytes,
  createDecryptionStream,
  createManifest,
  createParcelSender,
  encodeManifestJson,
  headerLength,
  labelLength,
  labelsPerPage,
  manifestRecordCount,
  manifestRecordLength,
  recordOverhead,
  recordReaderFromBytes,
} from "../src/index.ts"
import type { Manifest, OpenOptions, RecordReader } from "../src/index.ts"

export const fromChunks = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (controller) => {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }

      controller.close()
    },
  })

export const split = (bytes: Uint8Array, size: number): Uint8Array[] => {
  if (bytes.length === 0) {
    return []
  }

  const chunks: Uint8Array[] = []

  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size))
  }

  return chunks
}

export const collect = async (readable: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = []

  for await (const chunk of readable) {
    chunks.push(chunk)
  }

  return concatBytes(...chunks)
}

export const singleFileManifest = (size: number): Manifest => createManifest([{ name: "file.bin", size, mediaType: "application/octet-stream" }])

export interface SendInput {
  readonly secret: Uint8Array
  readonly data: Uint8Array
  readonly recordSizeExponent: number
  readonly salt?: Uint8Array
  readonly sequence?: number
  readonly manifest?: Manifest
  /** Reads records for the sending pass only; defaults to the same source as the labelling pass. */
  readonly readForSending?: RecordReader
}

/** Sends a whole parcel: the labelling pass reads `data`, the sending pass reads `readForSending` when given. */
export const encryptAll = async (input: SendInput): Promise<Uint8Array> => {
  const recordSize = 2 ** input.recordSizeExponent
  const labelling = recordReaderFromBytes(input.data, recordSize)
  let labelled = false

  const readRecord: RecordReader = async (index, length) => {
    const reader = labelled && input.readForSending !== undefined ? input.readForSending : labelling

    return reader(index, length)
  }

  const sender = await createParcelSender({
    linkSecret: input.secret,
    manifest: input.manifest ?? singleFileManifest(input.data.length),
    recordSizeExponent: input.recordSizeExponent,
    ...(input.salt === undefined ? {} : { salt: input.salt }),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    readRecord,
  })

  labelled = true

  return collect(sender.stream)
}

export const decryptAll = async (
  secret: Uint8Array,
  parcel: Uint8Array,
  chunkSize = 777,
  options: OpenOptions = {},
): Promise<{ manifest: Manifest; plaintext: Uint8Array }> => {
  const { stream, manifest } = createDecryptionStream(secret, options)
  const plaintext = await collect(fromChunks(split(parcel, chunkSize)).pipeThrough(stream))

  return { manifest: await manifest, plaintext }
}

/** Receives a parcel and returns what was released before it ended, and how it ended. */
export const receivePartially = async (secret: Uint8Array, parcel: Uint8Array): Promise<{ released: Uint8Array; outcome: string }> => {
  const { stream } = createDecryptionStream(secret)
  const reader = fromChunks(split(parcel, 4096)).pipeThrough(stream).getReader()
  const chunks: Uint8Array[] = []

  try {
    for (;;) {
      const next = await reader.read()

      if (next.done) {
        return { released: concatBytes(...chunks), outcome: "accepted" }
      }

      chunks.push(next.value)
    }
  } catch (error) {
    return { released: concatBytes(...chunks), outcome: error instanceof Error && "reason" in error ? String(error.reason) : `unexpected ${String(error)}` }
  }
}

/** The `reason` of the ParcelError a promise rejects with, or "accepted". */
export const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise

    return "accepted"
  } catch (error) {
    return error instanceof Error && "reason" in error ? String(error.reason) : `unexpected ${String(error)}`
  }
}

/** The same for a synchronous call. */
export const outcomeOf = (call: () => unknown): Promise<string> => outcome(Promise.resolve().then(call))

/** Byte offsets of each unit in a parcel built from `manifest` with records of `2^recordSizeExponent` bytes. */
export const layoutOf = (manifest: Manifest, recordSizeExponent: number) => {
  const size = 2 ** recordSizeExponent
  const manifestRecords = manifestRecordCount(encodeManifestJson(manifest).length)
  const manifestRecordStarts = Array.from({ length: manifestRecords }, (_, index) => headerLength + index * manifestRecordLength)
  const count = Math.max(1, Math.ceil(manifest.totalSize / size))
  const pageCount = Math.ceil(count / labelsPerPage)
  const pages: { start: number; end: number }[] = []
  const data: { start: number; end: number }[] = []
  let offset = headerLength + manifestRecords * manifestRecordLength

  for (let page = 0; page < pageCount; page++) {
    const first = page * labelsPerPage
    const last = Math.min(count, first + labelsPerPage)
    const pageLength = labelLength * (last - first + auditPath(pageCount, page).length)
    pages.push({ start: offset, end: offset + pageLength })
    offset += pageLength

    for (let index = first; index < last; index++) {
      const length = (index < count - 1 ? size : manifest.totalSize - (count - 1) * size) + recordOverhead
      data.push({ start: offset, end: offset + length })
      offset += length
    }
  }

  return { manifestRecordStarts, pages, data, end: offset }
}
