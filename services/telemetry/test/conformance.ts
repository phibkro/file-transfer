import { describe, expect, it } from "bun:test"
import { Effect, type Layer } from "effect"
import fc from "fast-check"
import { eventKinds, sizeBucketFor, sizeBuckets, Telemetry, type TelemetryEvent } from "../src/index.ts"

const eventArbitrary: fc.Arbitrary<TelemetryEvent> = fc.oneof(
  fc.record({ kind: fc.constantFrom(...eventKinds) }),
  fc.record({ kind: fc.constant("transfer-completed" as const), sizeBucket: fc.constantFrom(...sizeBuckets) }),
)

export const telemetryConformance = (name: string, layer: Layer.Layer<Telemetry>) => {
  describe(`Telemetry conformance: ${name}`, () => {
    it("counts every recorded event exactly once", async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(eventArbitrary, { maxLength: 100 }), async (events) => {
          const snapshot = await Effect.runPromise(
            Effect.provide(
              Effect.gen(function* () {
                const telemetry = yield* Telemetry
                yield* Effect.forEach(events, (event) => telemetry.record(event))
                return yield* telemetry.snapshot
              }),
              layer,
            ),
          )
          for (const kind of eventKinds) expect(snapshot.byKind[kind]).toBe(events.filter((event) => event.kind === kind).length)
          for (const bucket of sizeBuckets) expect(snapshot.bySizeBucket[bucket]).toBe(events.filter((event) => event.sizeBucket === bucket).length)
        }),
        { numRuns: 50 },
      )
    })

    it("buckets sizes monotonically", () => {
      fc.assert(
        fc.property(fc.nat(), fc.nat(), (left, right) => {
          const order = (bytes: number) => sizeBuckets.indexOf(sizeBucketFor(bytes))
          if (left <= right) expect(order(left)).toBeLessThanOrEqual(order(right))
        }),
      )
    })
  })
}
