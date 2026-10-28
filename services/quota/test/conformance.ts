import { describe, expect, it } from "bun:test"
import { Effect, type Layer } from "effect"
import fc from "fast-check"
import { entitlementsFor, Quota } from "../src/index.ts"

/** The layer under test must use a window long enough that it cannot roll over during the test. */
export const quotaConformance = (name: string, layer: Layer.Layer<Quota>, maximumRoomsPerWindow: number) => {
  describe(`Quota conformance: ${name}`, () => {
    it("admits exactly the policy's number of rooms per client key within a window, independently per key", async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(fc.constantFrom("client-a", "client-b", "client-c"), { maxLength: 40 }), async (requests) => {
          const admittedByKey = await Effect.runPromise(
            Effect.provide(
              Effect.gen(function* () {
                const quota = yield* Quota
                const admitted = new Map<string, number>()
                for (const clientKey of requests) {
                  const result = yield* Effect.result(quota.admitRoomCreation(clientKey))
                  if (result._tag === "Success") admitted.set(clientKey, (admitted.get(clientKey) ?? 0) + 1)
                }
                return admitted
              }),
              layer,
            ),
          )
          for (const clientKey of new Set(requests)) {
            const requested = requests.filter((key) => key === clientKey).length
            expect(admittedByKey.get(clientKey) ?? 0).toBe(Math.min(requested, maximumRoomsPerWindow))
          }
        }),
        { numRuns: 50 },
      )
    })

    it("never caps direct transfers and orders priority by plan", () => {
      const free = entitlementsFor("free")
      const paid = entitlementsFor("paid")
      const team = entitlementsFor("team")
      expect(free.startsRelayed).toBe(false)
      expect(paid.startsRelayed).toBe(true)
      expect(free.relayPriority < paid.relayPriority && paid.relayPriority < team.relayPriority).toBe(true)
    })
  })
}
