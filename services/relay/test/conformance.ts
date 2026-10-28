/**
 * The Relay service's conformance suite: one check per guarantee in `relayGuarantees`. Every platform layer runs
 * `relaySuite.run` and `relaySuite.negativeControls` with its own broken variants, as the reference layer does.
 */
import { conformanceSuite } from "@file-transfer/conformance"
import { expect } from "vite-plus/test"
import { Effect, type Layer, Option } from "effect"
import fc from "fast-check"
import { Relay, relayGuarantees, type RelayGuarantee } from "../src/index.ts"

const runner =
  (layer: Layer.Layer<Relay>) =>
  <A, E>(effect: Effect.Effect<A, E, Relay>) =>
    Effect.runPromise(Effect.provide(effect, layer))

/** Frames that are all different, so an order check cannot pass by accident. */
const distinctFramesArbitrary = fc
  .array(fc.uint8Array({ maxLength: 32 }), { minLength: 2, maxLength: 20 })
  .map((frames) => frames.map((frame, index) => Uint8Array.from([index, ...frame])))

const operationArbitrary = fc.oneof(
  fc.record({ kind: fc.constant("push" as const), frame: fc.uint8Array({ maxLength: 64 }) }),
  fc.record({ kind: fc.constant("take" as const) }),
  fc.record({ kind: fc.constant("grant" as const), credits: fc.integer({ min: 0, max: 4 }) }),
)

const asArrays = (frames: ReadonlyArray<Uint8Array>) => frames.map((frame) => Array.from(frame))

export const relaySuite = conformanceSuite<Relay, RelayGuarantee>({
  service: "Relay",
  guarantees: relayGuarantees,
  checks: {
    "relay/order": async (layer) => {
      await fc.assert(
        fc.asyncProperty(distinctFramesArbitrary, async (frames) => {
          const delivered = await runner(layer)(
            Effect.gen(function* () {
              const relay = yield* Relay
              const sessionIdentifier = yield* relay.open({ initialCredits: frames.length })
              for (const frame of frames) yield* relay.push({ sessionIdentifier, frame })
              const received: Array<Uint8Array> = []
              for (let index = 0; index < frames.length; index++) {
                const frame = yield* relay.take(sessionIdentifier)
                if (Option.isSome(frame)) received.push(frame.value)
              }
              return received
            }),
          )
          expect(asArrays(delivered)).toEqual(asArrays(frames))
        }),
        { numRuns: 50 },
      )
    },

    "relay/credit-bound": async (layer) => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 0, max: 8 }), fc.array(operationArbitrary, { maxLength: 60 }), async (initialCredits, operations) => {
          await runner(layer)(
            Effect.gen(function* () {
              const relay = yield* Relay
              const sessionIdentifier = yield* relay.open({ initialCredits })
              let modelCredits = initialCredits
              let modelQueued = 0
              let granted = initialCredits
              for (const operation of operations) {
                if (operation.kind === "push") {
                  const result = yield* Effect.result(relay.push({ sessionIdentifier, frame: operation.frame }))
                  expect(result._tag).toBe(modelCredits > 0 ? "Success" : "Failure")
                  if (result._tag === "Success") {
                    modelCredits--
                    modelQueued++
                  }
                } else if (operation.kind === "take") {
                  const frame = yield* relay.take(sessionIdentifier)
                  if (Option.isSome(frame)) modelQueued--
                } else {
                  yield* relay.grant({ sessionIdentifier, credits: operation.credits })
                  modelCredits += operation.credits
                  granted += operation.credits
                }
              }
              const meter = yield* relay.meter(sessionIdentifier)
              expect(meter.creditsAvailable).toBe(modelCredits)
              expect(meter.framesQueued).toBe(modelQueued)
              expect(meter.framesQueued + meter.framesForwarded).toBeLessThanOrEqual(granted)
            }),
          )
        }),
        { numRuns: 100 },
      )
    },

    "relay/exact-metering": async (layer) => {
      await fc.assert(
        fc.asyncProperty(fc.array(fc.uint8Array({ minLength: 1, maxLength: 64 }), { minLength: 1, maxLength: 20 }), fc.nat(), async (frames, takeSeed) => {
          const takes = takeSeed % (frames.length + 1)
          const outcome = await runner(layer)(
            Effect.gen(function* () {
              const relay = yield* Relay
              const sessionIdentifier = yield* relay.open({ initialCredits: frames.length })
              for (const frame of frames) yield* relay.push({ sessionIdentifier, frame })
              for (let index = 0; index < takes; index++) yield* relay.take(sessionIdentifier)
              return yield* relay.meter(sessionIdentifier)
            }),
          )
          expect(outcome.framesForwarded).toBe(takes)
          expect(outcome.bytesForwarded).toBe(frames.slice(0, takes).reduce((sum, frame) => sum + frame.length, 0))
          expect(outcome.framesQueued).toBe(frames.length - takes)
        }),
        { numRuns: 50 },
      )
    },

    "relay/close-stops-writes": async (layer) => {
      const outcome = await runner(layer)(
        Effect.gen(function* () {
          const relay = yield* Relay
          const sessionIdentifier = yield* relay.open({ initialCredits: 2 })
          yield* relay.push({ sessionIdentifier, frame: new Uint8Array([1]) })
          yield* relay.close(sessionIdentifier)
          const push = yield* Effect.result(relay.push({ sessionIdentifier, frame: new Uint8Array([2]) }))
          const grant = yield* Effect.result(relay.grant({ sessionIdentifier, credits: 1 }))
          const drained = yield* relay.take(sessionIdentifier)
          return {
            push: push._tag === "Failure" ? push.failure._tag : "accepted",
            grant: grant._tag === "Failure" ? grant.failure._tag : "accepted",
            drained: Option.isSome(drained),
          }
        }),
      )
      expect(outcome).toEqual({ push: "RelaySessionClosed", grant: "RelaySessionClosed", drained: true })
    },

    "relay/unknown-not-found": async (layer) => {
      const tag = await runner(layer)(
        Effect.gen(function* () {
          const relay = yield* Relay
          const result = yield* Effect.result(relay.meter("no-such-session"))
          return result._tag === "Failure" ? result.failure._tag : "found"
        }),
      )
      expect(tag).toBe("RelaySessionNotFound")
    },
  },
})
