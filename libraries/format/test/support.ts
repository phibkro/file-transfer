/** Helpers for the format tests: run whole transfers through the streams with chosen chunking. */
import { concatBytes, createDecryptionStream, createEncryptionStream, createManifest, type Manifest } from "../src/index.ts"

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

export const decryptAll = async (secret: Uint8Array, ciphertext: Uint8Array, chunkSize = 777): Promise<{ manifest: Manifest; plaintext: Uint8Array }> => {
  const { stream, manifest } = createDecryptionStream(secret)
  const plaintext = await collect(fromChunks(split(ciphertext, chunkSize)).pipeThrough(stream))
  return { manifest: await manifest, plaintext }
}

/** The `reason` of the FormatError a promise rejects with, or "accepted". */
export const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
    return "accepted"
  } catch (error) {
    return error instanceof Error && "reason" in error ? String(error.reason) : `unexpected ${String(error)}`
  }
}
