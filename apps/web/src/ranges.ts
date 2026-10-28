/**
 * Record bookkeeping for both ends: which records a recipient holds (and so which ranges it wants), and which
 * records a sender still owes and in what order it sends them.
 */

/** Half-open `[start, end)` range of data record indexes, as `want` carries them. */
export type RecordRange = readonly [number, number]

/** The most ranges one `want` message may carry (docs/protocol.md). */
export const maximumRangesPerWant = 1024

/** One bit per data record. */
export interface RecordSet {
  readonly bits: Uint8Array
  readonly size: number
  count: number
}

export const createRecordSet = (size: number): RecordSet => ({ bits: new Uint8Array(Math.ceil(size / 8)), size, count: 0 })

export const hasRecord = (set: RecordSet, index: number): boolean => ((set.bits[index >> 3] ?? 0) & (1 << (index & 7))) !== 0

/** Adds `index`; answers whether it was new. */
export const addRecord = (set: RecordSet, index: number): boolean => {
  if (index < 0 || index >= set.size || hasRecord(set, index)) return false
  set.bits[index >> 3] = (set.bits[index >> 3] ?? 0) | (1 << (index & 7))
  set.count++
  return true
}

/** Removes `index`; answers whether it was present. */
export const removeRecord = (set: RecordSet, index: number): boolean => {
  if (index < 0 || index >= set.size || !hasRecord(set, index)) return false
  set.bits[index >> 3] = (set.bits[index >> 3] ?? 0) & ~(1 << (index & 7))
  set.count--
  return true
}

export const isComplete = (set: RecordSet): boolean => set.count === set.size

/** Whether every record from `start` to `end - 1` is in the set. */
export const containsRange = (set: RecordSet, start: number, end: number): boolean => {
  for (let index = start; index < end; index++) if (!hasRecord(set, index)) return false
  return true
}

/** The ranges of records below `end` that are not in the set, in order, at most `limit` of them. */
export const missingRanges = (set: RecordSet, end: number = set.size, limit: number = maximumRangesPerWant): ReadonlyArray<RecordRange> => {
  const ranges: Array<RecordRange> = []
  let start = -1
  const last = Math.min(end, set.size)
  for (let index = 0; index < last && ranges.length < limit; index++) {
    const missing = !hasRecord(set, index)
    if (missing && start < 0) start = index
    if (!missing && start >= 0) {
      ranges.push([start, index])
      start = -1
    }
  }
  if (start >= 0 && ranges.length < limit) ranges.push([start, last])
  return ranges
}

/** Coalesces record indexes (any order, duplicates allowed) into sorted ranges. */
export const rangesOf = (indexes: Iterable<number>): ReadonlyArray<RecordRange> => {
  const sorted = [...new Set(indexes)].sort((left, right) => left - right)
  const ranges: Array<RecordRange> = []
  for (const index of sorted) {
    const previous = ranges.at(-1)
    if (previous !== undefined && previous[1] === index) ranges[ranges.length - 1] = [previous[0], index + 1]
    else ranges.push([index, index + 1])
  }
  return ranges
}

/** Whether every range is well formed and inside `[0, size)`. */
export const rangesAreValid = (ranges: ReadonlyArray<RecordRange>, size: number): boolean =>
  ranges.every(([start, end]) => Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < end && end <= size)

/**
 * What a sender owes one recipient. After an `accept` it owes every record, in order. A `want` that arrives before
 * the first credit after that `accept` replaces the debt (resume: the recipient lists what it still lacks); a later
 * `want` adds its ranges in front of the rest (a dropped record).
 */
export interface Schedule {
  readonly owed: RecordSet
  /** Records requested by a later `want`, sent before the sequential cursor. */
  priority: Array<number>
  /** Next index the sequential scan looks at. */
  cursor: number
}

export const createSchedule = (size: number): Schedule => {
  const owed = createRecordSet(size)
  for (let index = 0; index < size; index++) addRecord(owed, index)
  return { owed, priority: [], cursor: 0 }
}

/** Replaces the debt with exactly `ranges`. */
export const replaceDebt = (schedule: Schedule, ranges: ReadonlyArray<RecordRange>): void => {
  schedule.owed.bits.fill(0)
  schedule.owed.count = 0
  schedule.priority = []
  schedule.cursor = 0
  for (const [start, end] of ranges) for (let index = start; index < end; index++) addRecord(schedule.owed, index)
}

/** Owes `ranges` again, ahead of everything else. */
export const prioritise = (schedule: Schedule, ranges: ReadonlyArray<RecordRange>): void => {
  const front: Array<number> = []
  for (const [start, end] of ranges) {
    for (let index = start; index < end; index++) {
      addRecord(schedule.owed, index)
      front.push(index)
    }
  }
  schedule.priority = [...front, ...schedule.priority]
}

/** The next record to send, without marking it sent; undefined when nothing is owed. */
export const peekNext = (schedule: Schedule): number | undefined => {
  while (schedule.priority.length > 0) {
    const index = schedule.priority[0] ?? 0
    if (hasRecord(schedule.owed, index)) return index
    schedule.priority.shift()
  }
  while (schedule.cursor < schedule.owed.size && !hasRecord(schedule.owed, schedule.cursor)) schedule.cursor++
  return schedule.cursor < schedule.owed.size ? schedule.cursor : undefined
}

export const markSent = (schedule: Schedule, index: number): void => {
  removeRecord(schedule.owed, index)
}
