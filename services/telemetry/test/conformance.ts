/** The Telemetry service's conformance suite: one check per guarantee in `telemetryGuarantees`. */
import { conformanceSuite } from "@file-transfer/conformance"
import { expect } from "bun:test"
import { Effect, type Layer } from "effect"
import fc from "fast-check"
import { eventKinds, sizeBuckets, Telemetry, type TelemetryEvent, telemetryGuarantees, type TelemetryGuarantee } from "../src/index.ts"

const eventArbitrary: fc.Arbitrary<TelemetryEvent> = fc.oneof(
  fc.record({ kind: fc.constantFrom(...eventKinds) }),
  fc.record({ kind: fc.constant("transfer-completed" as const), sizeBucket: fc.constantFrom(...sizeBuckets) }),
)

const recordAll = (layer: Layer.Layer<Telemetry>, events: ReadonlyArray<TelemetryEvent>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry
        yield* Effect.forEach(events, (event) => telemetry.record(event))
        return yield* telemetry.snapshot
      }),
      layer,
    ),
  )

export const telemetrySuite = conformanceSuite<Telemetry, TelemetryGuarantee>({
  service: "Telemetry",
  guarantees: telemetryGuarantees,
  checks: {
    "telemetry/exact-counts": async (layer) => {
      await fc.assert(
        fc.asyncProperty(fc.array(eventArbitrary, { maxLength: 100 }), async (events) => {
          const snapshot = await recordAll(layer, events)
          for (const kind of eventKinds) expect(snapshot.byKind[kind]).toBe(events.filter((event) => event.kind === kind).length)
          for (const bucket of sizeBuckets) expect(snapshot.bySizeBucket[bucket]).toBe(events.filter((event) => event.sizeBucket === bucket).length)
        }),
        { numRuns: 50 },
      )
    },

    "telemetry/aggregate-only": async (layer) => {
      await fc.assert(
        fc.asyncProperty(fc.array(eventArbitrary, { minLength: 1, maxLength: 20 }), async (events) => {
          const snapshot = await recordAll(layer, events)
          expect(Object.keys(snapshot).sort()).toEqual(["byKind", "bySizeBucket"])
          expect(Object.keys(snapshot.byKind).sort()).toEqual([...eventKinds].sort())
          expect(Object.keys(snapshot.bySizeBucket).sort()).toEqual([...sizeBuckets].sort())
          for (const count of [...Object.values(snapshot.byKind), ...Object.values(snapshot.bySizeBucket)]) expect(Number.isSafeInteger(count)).toBe(true)
        }),
        { numRuns: 20 },
      )
    },
  },
})
