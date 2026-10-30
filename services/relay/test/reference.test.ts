import { secureRandom } from "@file-transfer/conformance"
import { Layer } from "effect"
import { describe, expect, it } from "vite-plus/test"
import * as Machine from "@file-transfer/machine"
import { makeRelayReference, RelayReference, relayGuarantees, relaySessionMachine } from "../src/index.ts"
import { relaySuite } from "./conformance.ts"

relaySuite.run("reference", Layer.provide(RelayReference, secureRandom))

relaySuite.negativeControls(
  "reference",
  relayGuarantees.map((guarantee) => ({
    violates: guarantee.identifier,
    layer: Layer.provide(makeRelayReference(new Set([guarantee.identifier])), secureRandom),
  })),
)

describe("RelaySession machine", () => {
  it("is well formed", () => {
    expect(Machine.problems(relaySessionMachine)).toEqual([])
  })
})
