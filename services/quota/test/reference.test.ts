import { describe, expect, it } from "vite-plus/test"
import { admitInWindow, entitlementsFor, makeQuotaReference, quotaGuarantees } from "../src/index.ts"
import { quotaSuite } from "./conformance.ts"

const policy = { maximumRoomsPerWindow: 5, windowMilliseconds: 60 * 60 * 1000 }
const suite = quotaSuite(policy)

suite.run("reference", makeQuotaReference(policy))

suite.negativeControls(
  "reference",
  quotaGuarantees.map((guarantee) => ({ violates: guarantee.identifier, layer: makeQuotaReference(policy, new Set([guarantee.identifier])) })),
)

describe("entitlements", () => {
  it("never caps direct transfers and orders relay priority by plan", () => {
    const free = entitlementsFor("free")
    const paid = entitlementsFor("paid")
    const team = entitlementsFor("team")
    expect(free.startsRelayed).toBe(false)
    expect(paid.startsRelayed).toBe(true)
    expect(free.relayPriority < paid.relayPriority && paid.relayPriority < team.relayPriority).toBe(true)
  })
})

describe("admitInWindow", () => {
  const small = { maximumRoomsPerWindow: 2, windowMilliseconds: 1000 }

  it("starts a window, fills it, refuses until it ends, then starts the next", () => {
    const first = admitInWindow(undefined, 0, small)
    expect(first).toEqual({ admitted: true, window: { windowStart: 0, count: 1 } })
    const second = first.admitted ? admitInWindow(first.window, 10, small) : first
    expect(second).toEqual({ admitted: true, window: { windowStart: 0, count: 2 } })
    expect(admitInWindow({ windowStart: 0, count: 2 }, 400, small)).toEqual({ admitted: false, retryAfterMilliseconds: 600 })
    expect(admitInWindow({ windowStart: 0, count: 2 }, 1000, small)).toEqual({ admitted: true, window: { windowStart: 1000, count: 1 } })
  })
})
