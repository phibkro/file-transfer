/**
 * The parcel's plaintext is the manifest's files concatenated in order. A data record covers a span of that stream,
 * which may cross file boundaries; these functions map a stream span to the file pieces it covers.
 */
/** A span that does not lie inside the stream; plain data, so the browser bundle needs no Effect. */
export interface SpanOutsideStream {
  readonly _tag: "SpanOutsideStream"
  readonly streamOffset: number
  readonly length: number
  readonly total: number
}

export type Spans = { readonly ok: true; readonly spans: readonly FileSpan[] } | { readonly ok: false; readonly error: SpanOutsideStream }

export interface FileSpan {
  /** Position of the file in the manifest. */
  readonly fileIndex: number
  /** Where the piece starts inside the file. */
  readonly fileOffset: number
  /** Where the piece starts inside the span's bytes. */
  readonly spanOffset: number
  readonly length: number
}

/** Start offset of each file in the concatenated stream. */
export const fileStarts = (sizes: readonly number[]): readonly number[] => {
  const starts: number[] = []
  let offset = 0

  for (const size of sizes) {
    starts.push(offset)
    offset += size
  }

  return starts
}

/** The last file whose start is at or before `offset`, skipping empty files. */
const fileAt = (starts: readonly number[], sizes: readonly number[], offset: number): number => {
  let low = 0
  let high = starts.length - 1

  while (low < high) {
    const middle = (low + high + 1) >> 1

    if ((starts[middle] ?? 0) <= offset) {
      low = middle
    } else {
      high = middle - 1
    }
  }

  while (low < sizes.length - 1 && (sizes[low] ?? 0) === 0) {
    low++
  }

  return low
}

/**
 * The pieces of the files that bytes `streamOffset` to `streamOffset + length - 1` of the stream cover, in order.
 * Empty files never get a piece; a span outside the stream fails with `SpanOutsideStream`.
 */
export const spansFor = (sizes: readonly number[], streamOffset: number, length: number): Spans => {
  const total = sizes.reduce((sum, size) => sum + size, 0)

  if (!Number.isSafeInteger(streamOffset) || !Number.isSafeInteger(length) || streamOffset < 0 || length < 0 || streamOffset + length > total) {
    return { ok: false, error: { _tag: "SpanOutsideStream", streamOffset, length, total } }
  }

  return { ok: true, spans: length === 0 ? [] : collectSpans(sizes, streamOffset, length) }
}

const collectSpans = (sizes: readonly number[], streamOffset: number, length: number): readonly FileSpan[] => {
  const starts = fileStarts(sizes)
  const spans: FileSpan[] = []
  let fileIndex = fileAt(starts, sizes, streamOffset)
  let position = streamOffset
  const end = streamOffset + length

  while (position < end) {
    const fileStart = starts[fileIndex] ?? 0
    const fileEnd = fileStart + (sizes[fileIndex] ?? 0)
    const pieceEnd = Math.min(end, fileEnd)

    if (pieceEnd > position) {
      spans.push({ fileIndex, fileOffset: position - fileStart, spanOffset: position - streamOffset, length: pieceEnd - position })
      position = pieceEnd
    }

    fileIndex++
  }

  return spans
}
