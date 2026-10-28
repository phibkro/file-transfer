import * as fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import { consume, createCreditWindow, grantDue, maximumCreditsPerMessage, outstanding, receiveCredit, resetCredits, spendCredit } from "../src/credits.ts"

describe("recipient credit window", () => {
  it("grants the whole window first, then tops up at half", () => {
    const credits = createCreditWindow(64)
    expect(grantDue(credits, 1000)).toBe(64)

    for (let index = 0; index < 31; index++) {
      consume(credits)
    }

    expect(grantDue(credits, 1000)).toBe(0)
    consume(credits)
    expect(grantDue(credits, 1000)).toBe(32)
    expect(outstanding(credits)).toBe(64)
  })

  it("never grants more than the missing records need", () => {
    const credits = createCreditWindow(64)
    expect(grantDue(credits, 10)).toBe(10)

    for (let index = 0; index < 10; index++) {
      consume(credits)
    }

    expect(grantDue(credits, 0)).toBe(0)
  })

  it("starts over on a new connection", () => {
    const credits = createCreditWindow(8)
    grantDue(credits, 100)
    consume(credits)
    resetCredits(credits)
    expect(outstanding(credits)).toBe(0)
    expect(grantDue(credits, 100)).toBe(8)
  })

  it("clamps windows to what a credit message can carry", () => {
    expect(createCreditWindow(1).window).toBe(2)
    expect(createCreditWindow(maximumCreditsPerMessage + 1).window).toBe(maximumCreditsPerMessage)
    expect(createCreditWindow(Number.NaN).window).toBe(2)
  })

  it("keeps in-flight records within the window, and a sender spending every credit receives every missing record", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 128 }), fc.integer({ min: 0, max: 2000 }), fc.array(fc.boolean(), { maxLength: 400 }), (window, missing, steps) => {
        const credits = createCreditWindow(window)
        const balance = { available: 0 }
        let remaining = missing
        let inFlight = 0

        const grant = () => {
          const due = grantDue(credits, remaining)
          expect(due).toBeLessThanOrEqual(maximumCreditsPerMessage)
          receiveCredit(balance, due)
        }

        grant()

        const step = (sendFirst: boolean) => {
          if (sendFirst && spendCredit(balance)) {
            inFlight++
          } else if (inFlight > 0) {
            inFlight--
            remaining--
            consume(credits)
            grant()
          } else if (spendCredit(balance)) {
            inFlight++
          }

          expect(inFlight + balance.available).toBe(outstanding(credits))
          expect(outstanding(credits)).toBeLessThanOrEqual(window)
          expect(outstanding(credits)).toBeLessThanOrEqual(remaining)
        }

        for (const sendFirst of steps) {
          step(sendFirst)
        }

        while (remaining > 0) {
          step(true)
        }

        expect(outstanding(credits)).toBe(0)
      }),
    )
    // Up to 2000 missing records over 100 runs: seconds of work, so an explicit budget instead of the 5 s default.
  }, 30_000)
})
