/**
 * Credit accounting (docs/protocol.md, `credit`). The sender spends one credit per data record. The recipient keeps
 * at most `window` records in flight: it counts a record as consumed once it is written (or dropped), and tops the
 * window up when half of it is used, so the sender never waits on a round trip while the window is open.
 */

/** The most records one `credit` message may grant. */
export const maximumCreditsPerMessage = 4096

export interface CreditWindow {
  readonly window: number
  /** Credits granted on the current connection. */
  granted: number
  /** Records consumed on the current connection. */
  consumed: number
}

/** A window of `window` records, clamped to what one `credit` message can carry (2 to 4096). */
export const createCreditWindow = (window: number): CreditWindow => ({
  window: Math.min(maximumCreditsPerMessage, Math.max(2, Math.floor(Number.isFinite(window) ? window : 2))),
  granted: 0,
  consumed: 0,
})

export const outstanding = (credits: CreditWindow): number => Math.max(0, credits.granted - credits.consumed)

export const consume = (credits: CreditWindow): void => {
  credits.consumed++
}

/** A new connection starts with nothing granted. */
export const resetCredits = (credits: CreditWindow): void => {
  credits.granted = 0
  credits.consumed = 0
}

/**
 * How many credits to grant now, given the records still missing: nothing while more than half the window is
 * outstanding, otherwise enough to refill the window, never more than the missing records need. Records the grant.
 */
export const grantDue = (credits: CreditWindow, missing: number): number => {
  const inFlight = outstanding(credits)
  if (inFlight * 2 > credits.window) return 0
  const grant = Math.min(credits.window - inFlight, missing - inFlight, maximumCreditsPerMessage)
  if (grant <= 0) return 0
  credits.granted += grant
  return grant
}

/** The sender's side: credits it may still spend. */
export interface CreditBalance {
  available: number
}

export const receiveCredit = (balance: CreditBalance, records: number): void => {
  balance.available += records
}

/** Spends one credit; answers false when there is none. */
export const spendCredit = (balance: CreditBalance): boolean => {
  if (balance.available <= 0) return false
  balance.available--
  return true
}
