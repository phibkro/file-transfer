import { describe, expect, it } from "bun:test"
import { entitlementsFor, makeQuotaReference, quotaGuarantees } from "../src/index.ts"
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
