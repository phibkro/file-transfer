import { describe, expect, it } from "vite-plus/test"
import {
  addRelayed,
  answerFor,
  dayMilliseconds,
  dayOf,
  decodeBudgetAnswer,
  decodeBudgetReport,
  millisecondsUntilReset,
  relayedToday,
  reportStepFor,
  stepsCrossed,
} from "../src/relayBudget.ts"

// 2026-10-29T12:00:00Z
const noon = Date.UTC(2026, 9, 29, 12)
const nextDay = noon + dayMilliseconds

describe("days", () => {
  it("counts UTC days and the time until the next UTC midnight", () => {
    expect(dayOf(Date.UTC(2026, 9, 29))).toBe(dayOf(noon))
    expect(dayOf(Date.UTC(2026, 9, 30))).toBe(dayOf(noon) + 1)
    expect(millisecondsUntilReset(noon)).toBe(12 * 60 * 60 * 1000)
    expect(millisecondsUntilReset(Date.UTC(2026, 9, 29))).toBe(dayMilliseconds)
  })
})

describe("relayed today", () => {
  it("adds reports within a day and starts again the next day", () => {
    const morning = addRelayed(undefined, noon, 100)
    const evening = addRelayed(morning, noon + 1000, 50)
    expect(relayedToday(evening, noon)).toBe(150)
    expect(relayedToday(evening, nextDay)).toBe(0)
    expect(addRelayed(evening, nextDay, 7)).toEqual({ day: dayOf(nextDay), relayedBytes: 7 })
  })

  it("answers reached once the day's bytes meet the budget, with the wait until midnight", () => {
    expect(answerFor(addRelayed(undefined, noon, 99), noon, 100).budgetReached).toBe(false)
    expect(answerFor(addRelayed(undefined, noon, 100), noon, 100)).toEqual({ budgetReached: true, retryAfterMilliseconds: 12 * 60 * 60 * 1000 })
    expect(answerFor(addRelayed(undefined, noon, 500), nextDay, 100).budgetReached).toBe(false)
  })
})

describe("report steps", () => {
  it("are a 400th of the budget, between 1 MiB and 256 MiB", () => {
    expect(reportStepFor(100_000_000_000)).toBe(250_000_000)
    expect(reportStepFor(1_000_000_000_000)).toBe(256 * 1024 * 1024)
    expect(reportStepFor(8 * 1024 * 1024)).toBe(1024 * 1024)
  })

  it("counts whole steps crossed, including several in one frame", () => {
    const step = 1000
    expect(stepsCrossed(0, step - 1, step)).toBe(0)
    expect(stepsCrossed(step - 1, step, step)).toBe(1)
    expect(stepsCrossed(10, 3 * step + 10, step)).toBe(3)
  })
})

describe("bodies", () => {
  it("decodes reports and answers and refuses anything else", () => {
    expect(decodeBudgetReport({ bytes: 0, budgetBytes: 1 })).toEqual({ bytes: 0, budgetBytes: 1 })
    expect(decodeBudgetReport({ bytes: -1, budgetBytes: 1 })).toBeUndefined()
    expect(decodeBudgetReport({ bytes: 1, budgetBytes: 0 })).toBeUndefined()
    expect(decodeBudgetReport({ bytes: 1.5, budgetBytes: 10 })).toBeUndefined()
    expect(decodeBudgetReport("bytes")).toBeUndefined()
    expect(decodeBudgetAnswer({ budgetReached: true, retryAfterMilliseconds: 5 })).toEqual({ budgetReached: true, retryAfterMilliseconds: 5 })
    expect(decodeBudgetAnswer({ budgetReached: "yes", retryAfterMilliseconds: 5 })).toBeUndefined()
  })
})
