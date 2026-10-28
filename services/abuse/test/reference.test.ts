import { secureCrypto } from "@file-transfer/conformance"
import { Layer } from "effect"
import { describe, expect, it } from "bun:test"
import { AbuseReference, abuseGuarantees, makeAbuseReference, stripFragment } from "../src/index.ts"
import { abuseSuite } from "./conformance.ts"

abuseSuite.run("reference", Layer.provide(AbuseReference, secureCrypto))
abuseSuite.negativeControls(
  "reference",
  abuseGuarantees.map((guarantee) => ({ violates: guarantee.identifier, layer: Layer.provide(makeAbuseReference(new Set([guarantee.identifier])), secureCrypto) })),
)

describe("stripFragment", () => {
  it("drops everything from the first #", () => {
    expect(stripFragment("https://host/r/room#key#more")).toBe("https://host/r/room")
    expect(stripFragment("https://host/r/room")).toBe("https://host/r/room")
  })
})
