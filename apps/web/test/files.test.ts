import * as fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import { fileStarts, spansFor } from "../src/files.ts"
import type { FileSpan } from "../src/files.ts"

const spans = (sizes: readonly number[], offset: number, length: number): readonly FileSpan[] => {
  const result = spansFor(sizes, offset, length)

  if (!result.ok) {
    throw new Error(`unexpected failure for ${offset} + ${length}`)
  }

  return result.spans
}

/** The concatenated stream, then each file read back from the spans of every record. */
const reassemble = (sizes: readonly number[], recordSize: number) => {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  const stream = Uint8Array.from({ length: total }, (_, index) => index % 251)
  const files = sizes.map((size) => new Uint8Array(size))
  const written = sizes.map(() => 0)

  for (let offset = 0; offset < total; offset += recordSize) {
    const length = Math.min(recordSize, total - offset)

    for (const span of spans(sizes, offset, length)) {
      files[span.fileIndex]?.set(stream.subarray(offset + span.spanOffset, offset + span.spanOffset + span.length), span.fileOffset)
      written[span.fileIndex] = (written[span.fileIndex] ?? 0) + span.length
    }
  }

  return { stream, files, written, starts: fileStarts(sizes) }
}

describe("offset mapping from the stream to files", () => {
  it("covers every byte of every file exactly once, for any sizes and record size", () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 300 }), { minLength: 1, maxLength: 12 }), fc.integer({ min: 1, max: 97 }), (sizes, recordSize) => {
        const { stream, files, written, starts } = reassemble(sizes, recordSize)

        for (const [index, size] of sizes.entries()) {
          expect(written[index]).toBe(size)
          const start = starts[index] ?? 0
          expect(Array.from(files[index] ?? [])).toEqual(Array.from(stream.subarray(start, start + size)))
        }
      }),
    )
  })

  it("splits a record that crosses file boundaries and skips empty files", () => {
    expect(spans([3, 0, 0, 4, 2], 2, 6)).toEqual([
      { fileIndex: 0, fileOffset: 2, spanOffset: 0, length: 1 },
      { fileIndex: 3, fileOffset: 0, spanOffset: 1, length: 4 },
      { fileIndex: 4, fileOffset: 0, spanOffset: 5, length: 1 },
    ])
  })

  it("gives no pieces for an empty span or an empty parcel", () => {
    expect(spans([5], 5, 0)).toEqual([])
    expect(spans([0, 0], 0, 0)).toEqual([])
  })

  it("fails for spans outside the stream", () => {
    for (const [offset, length] of [
      [2, 3],
      [-1, 1],
      [0, 0.5],
    ] as const) {
      const result = spansFor([4], offset, length)
      expect(result.ok ? "spans" : result.error._tag).toBe("SpanOutsideStream")
    }
  })
})
