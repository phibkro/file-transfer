import fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import {
  addRecord,
  containsRange,
  createRecordSet,
  createSchedule,
  isComplete,
  markSent,
  maximumRangesPerWant,
  missingRanges,
  peekNext,
  prioritise,
  rangesAreValid,
  rangesOf,
  type RecordRange,
  replaceDebt,
} from "../src/ranges.ts"

const expand = (ranges: ReadonlyArray<RecordRange>) => ranges.flatMap(([start, end]) => Array.from({ length: end - start }, (_, offset) => start + offset))

/** Sends everything the schedule owes, in its order. */
const drain = (schedule: ReturnType<typeof createSchedule>) => {
  const sent: Array<number> = []
  for (let next = peekNext(schedule); next !== undefined; next = peekNext(schedule)) {
    sent.push(next)
    markSent(schedule, next)
  }
  return sent
}

describe("want ranges", () => {
  it("missing ranges are exactly the records not received, sorted and disjoint", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), fc.array(fc.nat({ max: 199 })), (size, received) => {
        const set = createRecordSet(size)
        for (const index of received) addRecord(set, index % size)
        const ranges = missingRanges(set)
        expect(rangesAreValid(ranges, size)).toBe(true)
        const expected = Array.from({ length: size }, (_, index) => index).filter((index) => !received.some((value) => value % size === index))
        expect(expand(ranges)).toEqual(expected)
        for (let index = 1; index < ranges.length; index++) expect(ranges[index]?.[0]).toBeGreaterThan(ranges[index - 1]?.[1] ?? 0)
        expect(isComplete(set)).toBe(expected.length === 0)
      }),
    )
  })

  it("caps the number of ranges and the end", () => {
    const set = createRecordSet(5000)
    for (let index = 0; index < 5000; index += 2) addRecord(set, index)
    expect(missingRanges(set).length).toBe(maximumRangesPerWant)
    expect(missingRanges(set, 6)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ])
  })

  it("coalesces indexes into ranges", () => {
    expect(rangesOf([7, 3, 4, 5, 9, 4, 8])).toEqual([
      [3, 6],
      [7, 10],
    ])
    expect(rangesOf([])).toEqual([])
  })

  it("rejects malformed ranges", () => {
    expect(rangesAreValid([[0, 0]], 4)).toBe(false)
    expect(rangesAreValid([[2, 5]], 4)).toBe(false)
    expect(rangesAreValid([[-1, 1]], 4)).toBe(false)
    expect(rangesAreValid([[0, 4]], 4)).toBe(true)
  })

  it("counts each record once and reports page coverage", () => {
    const set = createRecordSet(10)
    expect(addRecord(set, 3)).toBe(true)
    expect(addRecord(set, 3)).toBe(false)
    expect(addRecord(set, 10)).toBe(false)
    expect(set.count).toBe(1)
    for (let index = 0; index < 5; index++) addRecord(set, index)
    expect(containsRange(set, 0, 5)).toBe(true)
    expect(containsRange(set, 0, 6)).toBe(false)
  })
})

describe("sender schedule", () => {
  it("owes every record in order after an accept", () => {
    expect(drain(createSchedule(5))).toEqual([0, 1, 2, 3, 4])
  })

  it("a resume want replaces the debt", () => {
    const schedule = createSchedule(10)
    replaceDebt(schedule, [
      [2, 4],
      [8, 10],
    ])
    expect(drain(schedule)).toEqual([2, 3, 8, 9])
  })

  it("a later want goes first, then the scan continues without repeats", () => {
    const schedule = createSchedule(8)
    for (let index = 0; index < 5; index++) markSent(schedule, peekNext(schedule) ?? -1)
    prioritise(schedule, [[1, 3]])
    expect(drain(schedule)).toEqual([1, 2, 5, 6, 7])
  })

  it("sends every owed record exactly once for any sequence of wants", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), fc.array(fc.tuple(fc.nat({ max: 59 }), fc.nat({ max: 59 }), fc.nat({ max: 10 }))), (size, wants) => {
        const schedule = createSchedule(size)
        const sent: Array<number> = []
        for (const [first, second, sendsBefore] of wants) {
          for (let step = 0; step < sendsBefore; step++) {
            const next = peekNext(schedule)
            if (next === undefined) break
            sent.push(next)
            markSent(schedule, next)
          }
          const start = Math.min(first, second) % size
          const end = Math.min(size, start + 1 + (Math.max(first, second) % 3))
          prioritise(schedule, [[start, end]])
        }
        sent.push(...drain(schedule))
        for (let index = 0; index < size; index++) expect(sent.includes(index)).toBe(true)
        expect(peekNext(schedule)).toBeUndefined()
      }),
    )
  })
})
