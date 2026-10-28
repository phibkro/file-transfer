/** Helpers for the parcel tests: run whole parcels through the streams with chosen chunking. */
import {
  concatBytes,
  createDecryptionStream,
  createEncryptionStream,
  createManifest,
  headerLength,
  type Manifest,
  manifestRecordCount,
  manifestRecordLength,
  encodeManifestJson,
  type OpenOptions,
  recordOverhead,
  trailerRecordLength,
} from "../src/index.ts"

export const fromChunks = (chunks: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

export const split = (bytes: Uint8Array, size: number): Array<Uint8Array> => {
  if (bytes.length === 0) return []
  const chunks: Array<Uint8Array> = []
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.subarray(offset, offset + size))
  return chunks
}

export const collect = async (readable: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Array<Uint8Array> = []
  for await (const chunk of readable) chunks.push(chunk)
  return concatBytes(...chunks)
}

export const singleFileManifest = (size: number): Manifest => createManifest([{ name: "file.bin", size, mediaType: "application/octet-stream" }])

export interface EncryptInput {
  readonly secret: Uint8Array
  readonly data: Uint8Array
  readonly recordSizeExponent: number
  readonly chunkSize?: number
  readonly salt?: Uint8Array
  readonly manifest?: Manifest
}

export const encryptAll = async (input: EncryptInput): Promise<Uint8Array> => {
  const { stream } = await createEncryptionStream({
    secret: input.secret,
    manifest: input.manifest ?? singleFileManifest(input.data.length),
    recordSizeExponent: input.recordSizeExponent,
    ...(input.salt === undefined ? {} : { salt: input.salt }),
  })
  return collect(fromChunks(split(input.data, input.chunkSize ?? 1000)).pipeThrough(stream))
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
  const manifestStart = headerLength
  const dataStart = manifestStart + manifestRecords * manifestRecordLength
  const count = Math.max(1, Math.ceil(manifest.totalSize / size))
  const data: Array<{ start: number; end: number }> = []
  let offset = dataStart
  for (let index = 0; index < count; index++) {
    const length = (index < count - 1 ? size : manifest.totalSize - (count - 1) * size) + recordOverhead
    data.push({ start: offset, end: offset + length })
    offset += length
  }
  const manifestRecordStarts = Array.from({ length: manifestRecords }, (_, index) => manifestStart + index * manifestRecordLength)
  return { manifestRecordStarts, dataStart, data, trailerStart: offset, end: offset + trailerRecordLength }
}
