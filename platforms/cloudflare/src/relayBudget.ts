/**
 * The instance's daily relay budget (`LIMIT_RELAYED_BYTES_PER_DAY`, limits.ts): how many bytes all rooms together may
 * relay per UTC day. Cloudflare's free daily allowances reset at 00:00 UTC
 * (https://developers.cloudflare.com/durable-objects/platform/pricing/), and once the account's Durable Object
 * requests run out every room fails, so the budget stops relaying a little before that (docs/spikes/0003).
 *
 * Rooms report what they relay in steps (`reportStepFor`) and when a socket closes, and stop when the answer says the
 * budget is reached; the Worker asks before creating a room. So the budget is approximate: each room can pass it by
 * about one step, a 400th of the budget at most. Pure: no I/O, no clock; the Durable Object (relayBudgetObject.ts) passes in the time.
 */
import { Result, Schema } from "effect"

export const dayMilliseconds = 24 * 60 * 60 * 1000

const mebibyte = 1024 * 1024

/**
 * The step in which rooms report relayed bytes for a budget: a 400th of it, between 1 MiB and 256 MiB. At the
 * 100 GB default that is 250 MB, four reports per GB, against the 775 requests a GB of relaying costs anyway.
 */
export const reportStepFor = (budgetBytes: number): number => Math.min(256 * mebibyte, Math.max(mebibyte, Math.floor(budgetBytes / 400)))

/** What the budget object stores: one UTC day and the bytes relayed in it. */
export interface BudgetDay {
  readonly day: number
  readonly relayedBytes: number
}

/** Days since the Unix epoch, in UTC. */
export const dayOf = (epochMilliseconds: number): number => Math.floor(epochMilliseconds / dayMilliseconds)

/** Milliseconds until the next UTC midnight, when the budget starts again. */
export const millisecondsUntilReset = (epochMilliseconds: number): number => (dayOf(epochMilliseconds) + 1) * dayMilliseconds - epochMilliseconds

/** Bytes relayed today, given what was stored (a stored earlier day counts as nothing). */
export const relayedToday = (stored: BudgetDay | undefined, epochMilliseconds: number): number =>
  stored !== undefined && stored.day === dayOf(epochMilliseconds) ? stored.relayedBytes : 0

/** The stored day after a report of `bytes`. */
export const addRelayed = (stored: BudgetDay | undefined, epochMilliseconds: number, bytes: number): BudgetDay => ({
  day: dayOf(epochMilliseconds),
  relayedBytes: relayedToday(stored, epochMilliseconds) + bytes,
})

/** The number of whole report steps a room crossed by relaying from `before` to `after` bytes. */
export const stepsCrossed = (before: number, after: number, step: number): number => Math.floor(after / step) - Math.floor(before / step)

/** A room's or the Worker's question to the budget object: `bytes` more were relayed (0 only asks). */
export interface BudgetReport {
  readonly bytes: number
  readonly budgetBytes: number
}

/** The budget object's answer. */
export interface BudgetAnswer {
  readonly budgetReached: boolean
  readonly retryAfterMilliseconds: number
}

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const decodeReportResult = Schema.decodeUnknownResult(Schema.Struct({ bytes: NonNegativeInteger, budgetBytes: Schema.Int.check(Schema.isGreaterThan(0)) }))

/** Decodes a report body, or undefined when it is not one. */
export const decodeBudgetReport = (body: unknown): BudgetReport | undefined => {
  const decoded = decodeReportResult(body)

  return Result.isSuccess(decoded) ? decoded.success : undefined
}

const decodeAnswerResult = Schema.decodeUnknownResult(Schema.Struct({ budgetReached: Schema.Boolean, retryAfterMilliseconds: NonNegativeInteger }))

/** Decodes the budget object's answer, or undefined when it is not one. */
export const decodeBudgetAnswer = (body: unknown): BudgetAnswer | undefined => {
  const decoded = decodeAnswerResult(body)

  return Result.isSuccess(decoded) ? decoded.success : undefined
}

/** The answer to a report, given the stored day after it. */
export const answerFor = (day: BudgetDay, epochMilliseconds: number, budgetBytes: number): BudgetAnswer => ({
  budgetReached: relayedToday(day, epochMilliseconds) >= budgetBytes,
  retryAfterMilliseconds: millisecondsUntilReset(epochMilliseconds),
})
