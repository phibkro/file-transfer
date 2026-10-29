/**
 * The Relay service's conformance suite: one check per guarantee in `relayGuarantees`. Every platform layer runs
 * `relaySuite.run` and `relaySuite.negativeControls` with its own broken variants, as the reference layer does.
 */
import { conformanceSuite, transitionTableCheck } from "@file-transfer/conformance"
import * as Machine from "@file-transfer/machine"
import { expect } from "vite-plus/test"
import { Effect, Option } from "effect"
import type { Layer } from "effect"
import * as fc from "fast-check"
import { Relay, relayGuarantees, relaySessionMachine } from "../src/index.ts"
import type { RelayGuarantee, RelaySessionState } from "../src/index.ts"

const runner =
  (layer: Layer.Layer<Relay>) =>
  async <A, E>(effect: Effect.Effect<A, E, Relay>) =>
    await Effect.runPromise(Effect.provide(effect, layer))

/** Frames that are all different, so an order check cannot pass by accident. */
const distinctFramesArbitrary = fc
  .array(fc.uint8Array({ maxLength: 32 }), { minLength: 2, maxLength: 20 })
  .map((frames) => frames.map((frame, index) => Uint8Array.from([index, ...frame])))

const operationArbitrary = fc.oneof(
  fc.record({ kind: fc.constant("push" as const), frame: fc.uint8Array({ maxLength: 64 }) }),
  fc.record({ kind: fc.constant("take" as const) }),
  fc.record({ kind: fc.constant("grant" as const), credits: fc.integer({ min: 0, max: 4 }) }),
)

/** A fresh session with one credit, so a push it allows can succeed. */
const openSession = Effect.gen(function* () {
  const relay = yield* Relay

  return yield* relay.open({ initialCredits: 1 })
})

const actOn =
  <E>(act: (relay: Relay["Service"], sessionIdentifier: string) => Effect.Effect<unknown, E>) =>
  (sessionIdentifier: string) =>
    Effect.gen(function* () {
      const relay = yield* Relay
      yield* act(relay, sessionIdentifier)

      return sessionIdentifier
    })

/** Drives a relay session through every pair of its machine's table. */
const followsMachine = transitionTableCheck(relaySessionMachine, {
  arrange: (state) =>
    Effect.gen(function* () {
      if (state === Machine.boundary) {
        return "no-such-session"
      }

      const sessionIdentifier = yield* openSession

      if (state === "Closed") {
        const relay = yield* Relay
        yield* Effect.orDie(relay.close(sessionIdentifier))
      }

      return sessionIdentifier
    }),
  apply: {
    openSession: () => openSession,
    pushFrame: actOn((relay, sessionIdentifier) => relay.push({ sessionIdentifier, frame: Uint8Array.of(1) })),
    grantCredits: actOn((relay, sessionIdentifier) => relay.grant({ sessionIdentifier, credits: 1 })),
    takeFrame: actOn((relay, sessionIdentifier) => relay.take(sessionIdentifier)),
    closeSession: actOn((relay, sessionIdentifier) => relay.close(sessionIdentifier)),
  },
  observe: (sessionIdentifier) =>
    Effect.gen(function* () {
      const relay = yield* Relay

      return yield* Effect.match(relay.meter(sessionIdentifier), {
        onFailure: (): RelaySessionState | Machine.Boundary => Machine.boundary,
        onSuccess: (meter) => meter.state,
      })
    }),
  inexpressible: [
    { state: "Open", command: "openSession", reason: "opening always makes a new session; nothing names an existing one" },
    { state: "Closed", command: "openSession", reason: "opening always makes a new session; nothing names an existing one" },
  ],
})

const asArrays = (frames: readonly Uint8Array[]) => frames.map((frame) => Array.from(frame))

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

              for (const frame of frames) {
                yield* relay.push({ sessionIdentifier, frame })
              }

              const received: Uint8Array[] = []

              for (const _sent of frames) {
                const frame = yield* relay.take(sessionIdentifier)

                if (Option.isSome(frame)) {
                  received.push(frame.value)
                }
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

                  if (Option.isSome(frame)) {
                    modelQueued--
                  }
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

              for (const frame of frames) {
                yield* relay.push({ sessionIdentifier, frame })
              }

              for (let index = 0; index < takes; index++) {
                yield* relay.take(sessionIdentifier)
              }

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

    "relay/follows-machine": followsMachine,
  },
})
