/** The Telemetry service's conformance suite: one check per guarantee in `telemetryGuarantees`. */
import { conformanceSuite } from "@file-transfer/conformance"
import { expect } from "vite-plus/test"
import { Effect } from "effect"
import type { Layer } from "effect"
import * as fc from "fast-check"
import { eventKinds, sizeBuckets, Telemetry, telemetryGuarantees } from "../src/index.ts"
import type { TelemetryEvent, TelemetryGuarantee } from "../src/index.ts"

const eventArbitrary: fc.Arbitrary<TelemetryEvent> = fc.oneof(
  fc.record({ kind: fc.constantFrom(...eventKinds) }),
  fc.record({
    kind: fc.constant("transfer-completed" as const),
    sizeBucket: fc.constantFrom(...sizeBuckets),
    relayedMegabytes: fc.integer({ min: 0, max: 20_000 }),
  }),
)

const recordAll = async (layer: Layer.Layer<Telemetry>, events: readonly TelemetryEvent[]) =>
  await Effect.runPromise(
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

          for (const kind of eventKinds) {
            expect(snapshot.byKind[kind]).toBe(events.filter((event) => event.kind === kind).length)
          }

          for (const bucket of sizeBuckets) {
            expect(snapshot.bySizeBucket[bucket]).toBe(events.filter((event) => event.sizeBucket === bucket).length)
          }

          expect(snapshot.relayedMegabytes).toBe(events.reduce((sum, event) => sum + (event.relayedMegabytes ?? 0), 0))
        }),
        { numRuns: 50 },
      )
    },

    "telemetry/aggregate-only": async (layer) => {
      await fc.assert(
        fc.asyncProperty(fc.array(eventArbitrary, { minLength: 1, maxLength: 20 }), async (events) => {
          const snapshot = await recordAll(layer, events)
          expect(Object.keys(snapshot).toSorted()).toEqual(["byKind", "bySizeBucket", "relayedMegabytes"])
          expect(Object.keys(snapshot.byKind).toSorted()).toEqual([...eventKinds].toSorted())
          expect(Object.keys(snapshot.bySizeBucket).toSorted()).toEqual([...sizeBuckets].toSorted())

          for (const count of [...Object.values(snapshot.byKind), ...Object.values(snapshot.bySizeBucket), snapshot.relayedMegabytes]) {
            expect(Number.isSafeInteger(count)).toBe(true)
          }
        }),
        { numRuns: 20 },
      )
    },
  },
})
