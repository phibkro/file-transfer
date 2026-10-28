/**
 * Conformance suite for the Relay service. Every platform layer must pass it,
 * alongside the reference layer. Run it with `relayConformance(name, layer)`.
 */
import { describe, expect, it } from "bun:test"
import { Effect, type Layer, Option } from "effect"
import fc from "fast-check"
import { Relay } from "../src/index.ts"

/** A random interleaving of sender pushes, recipient takes and credit grants. */
const operationArbitrary = fc.oneof(
  fc.record({ kind: fc.constant("push" as const), frame: fc.uint8Array({ maxLength: 64 }) }),
  fc.record({ kind: fc.constant("take" as const) }),
  fc.record({ kind: fc.constant("grant" as const), credits: fc.integer({ min: 0, max: 4 }) }),
)

export const relayConformance = (name: string, layer: Layer.Layer<Relay>) => {
  const run = <A, E>(effect: Effect.Effect<A, E, Relay>) => Effect.runPromise(Effect.provide(effect, layer))

  describe(`Relay conformance: ${name}`, () => {
    it("delivers accepted frames in order, never exceeds credits, and meters exactly what it delivered", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 0, max: 8 }), fc.array(operationArbitrary, { maxLength: 60 }), async (initialCredits, operations) => {
          const outcome = await run(
            Effect.gen(function* () {
              const relay = yield* Relay
              const sessionIdentifier = yield* relay.open({ initialCredits })
              const accepted: Array<Uint8Array> = []
              const delivered: Array<Uint8Array> = []
              let modelCredits = initialCredits
              let rejectedForCredit = 0
              for (const operation of operations) {
                if (operation.kind === "push") {
                  const result = yield* Effect.result(relay.push({ sessionIdentifier, frame: operation.frame }))
                  if (result._tag === "Success") {
                    accepted.push(operation.frame)
                    modelCredits--
                  } else if (result.failure._tag === "NoCreditAvailable") rejectedForCredit++
                } else if (operation.kind === "take") {
                  const frame = yield* relay.take(sessionIdentifier)
                  if (Option.isSome(frame)) delivered.push(frame.value)
                } else {
                  yield* relay.grant({ sessionIdentifier, credits: operation.credits })
                  modelCredits += operation.credits
                }
                expect(modelCredits).toBeGreaterThanOrEqual(0)
              }
              const meter = yield* relay.meter(sessionIdentifier)
              return { accepted, delivered, meter, modelCredits, rejectedForCredit }
            }),
          )
          const toArrays = (frames: ReadonlyArray<Uint8Array>) => frames.map((frame) => Array.from(frame))
          expect(toArrays(outcome.delivered)).toEqual(toArrays(outcome.accepted.slice(0, outcome.delivered.length)))
          expect(outcome.meter.framesForwarded).toBe(outcome.delivered.length)
          expect(outcome.meter.bytesForwarded).toBe(outcome.delivered.reduce((sum, frame) => sum + frame.length, 0))
          expect(outcome.meter.framesQueued).toBe(outcome.accepted.length - outcome.delivered.length)
          expect(outcome.meter.creditsAvailable).toBe(outcome.modelCredits)
        }),
        { numRuns: 100 },
      )
    })

    it("rejects pushes and grants after close, but still lets the recipient drain", async () => {
      const outcome = await run(
        Effect.gen(function* () {
          const relay = yield* Relay
          const sessionIdentifier = yield* relay.open({ initialCredits: 2 })
          yield* relay.push({ sessionIdentifier, frame: new Uint8Array([1]) })
          yield* relay.close(sessionIdentifier)
          const pushError = yield* Effect.flip(relay.push({ sessionIdentifier, frame: new Uint8Array([2]) }))
          const grantError = yield* Effect.flip(relay.grant({ sessionIdentifier, credits: 1 }))
          const drained = yield* relay.take(sessionIdentifier)
          return { pushError: pushError._tag, grantError: grantError._tag, drained: Option.isSome(drained) }
        }),
      )
      expect(outcome).toEqual({ pushError: "RelaySessionClosed", grantError: "RelaySessionClosed", drained: true })
    })

    it("reports unknown sessions as not found", async () => {
      const tag = await run(
        Effect.gen(function* () {
          const relay = yield* Relay
          const error = yield* Effect.flip(relay.meter("no-such-session"))
          return error._tag
        }),
      )
      expect(tag).toBe("RelaySessionNotFound")
    })
  })
}
