/**
 * The Quota service's conformance suite, parameterised by the admission policy the layer under test was built with.
 * Checks run under `TestClock`, so window boundaries are exact and no test waits on real time.
 */
import { conformanceSuite } from "@file-transfer/conformance"
import { expect } from "vite-plus/test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { Quota, quotaGuarantees } from "../src/index.ts"
import type { AdmissionPolicy, QuotaGuarantee } from "../src/index.ts"

const runner =
  (layer: Layer.Layer<Quota>) =>
  <A, E>(effect: Effect.Effect<A, E, Quota>) =>
    Effect.runPromise(Effect.provide(effect, Layer.mergeAll(layer, TestClock.layer())))

/** Requests admission `count` times and returns how many were admitted. */
const admitted = (quota: Quota["Service"], clientKey: string, count: number) =>
  Effect.gen(function* () {
    let admissions = 0

    for (let index = 0; index < count; index++) {
      const result = yield* Effect.result(quota.admitRoomCreation(clientKey))

      if (result._tag === "Success") {
        admissions++
      }
    }

    return admissions
  })

export const quotaSuite = (policy: AdmissionPolicy) =>
  conformanceSuite<Quota, QuotaGuarantee>({
    service: "Quota",
    guarantees: quotaGuarantees,
    checks: {
      "quota/per-key-limit": async (layer) => {
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 0, max: policy.maximumRoomsPerWindow * 3 }), async (requests) => {
            const admissions = await runner(layer)(
              Effect.gen(function* () {
                return yield* admitted(yield* Quota, "client", requests)
              }),
            )

            expect(admissions).toBe(Math.min(requests, policy.maximumRoomsPerWindow))
          }),
          { numRuns: 30 },
        )
      },

      "quota/keys-independent": async (layer) => {
        await fc.assert(
          fc.asyncProperty(fc.array(fc.constantFrom("client-a", "client-b", "client-c"), { maxLength: 40 }), async (requests) => {
            const admittedByKey = await runner(layer)(
              Effect.gen(function* () {
                const quota = yield* Quota
                const counts = new Map<string, number>()

                for (const clientKey of requests) {
                  counts.set(clientKey, (counts.get(clientKey) ?? 0) + (yield* admitted(quota, clientKey, 1)))
                }

                return counts
              }),
            )

            for (const clientKey of new Set(requests)) {
              const requested = requests.filter((key) => key === clientKey).length
              expect(admittedByKey.get(clientKey) ?? 0).toBe(Math.min(requested, policy.maximumRoomsPerWindow))
            }
          }),
          { numRuns: 50 },
        )
      },

      "quota/window-resets": async (layer) => {
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async (windowCount) => {
            const perWindow = await runner(layer)(
              Effect.gen(function* () {
                const quota = yield* Quota
                const counts: number[] = []

                for (let index = 0; index < windowCount; index++) {
                  counts.push(yield* admitted(quota, "client", policy.maximumRoomsPerWindow + 1))
                  yield* TestClock.adjust(policy.windowMilliseconds)
                }

                return counts
              }),
            )

            expect(perWindow).toEqual(Array.from({ length: windowCount }, () => policy.maximumRoomsPerWindow))
          }),
          { numRuns: 10 },
        )
      },

      "quota/honest-retry-after": async (layer) => {
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 0, max: policy.windowMilliseconds - 1 }), async (elapsed) => {
            const outcome = await runner(layer)(
              Effect.gen(function* () {
                const quota = yield* Quota
                yield* admitted(quota, "client", policy.maximumRoomsPerWindow)
                yield* TestClock.adjust(elapsed)
                const rejection = yield* Effect.flip(quota.admitRoomCreation("client"))

                const waitedTooLittle =
                  rejection.retryAfterMilliseconds > 0
                    ? yield* Effect.result(Effect.andThen(TestClock.adjust(rejection.retryAfterMilliseconds - 1), quota.admitRoomCreation("client")))
                    : undefined

                yield* TestClock.adjust(1)
                const afterWaiting = yield* Effect.result(quota.admitRoomCreation("client"))

                return { retryAfter: rejection.retryAfterMilliseconds, tooEarly: waitedTooLittle?._tag, afterWaiting: afterWaiting._tag }
              }),
            )

            expect(outcome).toEqual({ retryAfter: policy.windowMilliseconds - elapsed, tooEarly: "Failure", afterWaiting: "Success" })
          }),
          { numRuns: 30 },
        )
      },
    },
  })
