import { describe, expect, it } from "vite-plus/test"
import * as fc from "fast-check"
import { makeTelemetryReference, sizeBucketFor, sizeBuckets, TelemetryReference, telemetryGuarantees } from "../src/index.ts"
import { telemetrySuite } from "./conformance.ts"

telemetrySuite.run("reference", TelemetryReference)

telemetrySuite.negativeControls(
  "reference",
  telemetryGuarantees.map((guarantee) => ({ violates: guarantee.identifier, layer: makeTelemetryReference(new Set([guarantee.identifier])) })),
)

const order = (bytes: number) => sizeBuckets.indexOf(sizeBucketFor(bytes))

describe("size buckets", () => {
  it("are monotonic in bytes", () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), (left, right) => {
        if (left <= right) {
          expect(order(left)).toBeLessThanOrEqual(order(right))
        }
      }),
    )
  })
})
