import { describe, expect, it } from "bun:test"
import { Effect, type Layer } from "effect"
import fc from "fast-check"
import { Abuse } from "../src/index.ts"

export const abuseConformance = (name: string, layer: Layer.Layer<Abuse>) => {
  const run = <A, E>(effect: Effect.Effect<A, E, Abuse>) => Effect.runPromise(Effect.provide(effect, layer))

  describe(`Abuse conformance: ${name}`, () => {
    it("never stores the URL fragment of a notice location", async () => {
      await fc.assert(
        fc.asyncProperty(fc.webUrl(), fc.string({ minLength: 1 }), async (url, fragment) => {
          const receipt = await run(
            Effect.gen(function* () {
              const abuse = yield* Abuse
              return yield* abuse.submitNotice({
                location: `${url}#${fragment}`,
                explanation: "illegal content",
                submitterName: "A. Person",
                submitterEmail: "person@example.com",
                statementOfGoodFaith: true,
              })
            }),
          )
          expect(receipt.storedLocation.includes("#")).toBe(false)
          expect(receipt.storedLocation).toBe(url.split("#")[0]!)
        }),
        { numRuns: 50 },
      )
    })

    it("rejects incomplete notices and revokes rooms on a revoke decision", async () => {
      const outcome = await run(
        Effect.gen(function* () {
          const abuse = yield* Abuse
          const incomplete = yield* Effect.flip(
            abuse.submitNotice({ location: "", explanation: "x", submitterName: "y", submitterEmail: "z@example.com", statementOfGoodFaith: true }),
          )
          const receipt = yield* abuse.submitNotice({
            location: "https://host/r/room-1#secret",
            explanation: "malware",
            submitterName: "A. Person",
            submitterEmail: "person@example.com",
            statementOfGoodFaith: true,
          })
          const before = yield* abuse.isRevoked("room-1")
          yield* abuse.decide({ noticeIdentifier: receipt.noticeIdentifier, decision: { kind: "revoke", roomIdentifier: "room-1", reason: "malware" } })
          const after = yield* abuse.isRevoked("room-1")
          return { incomplete: incomplete._tag, before, after }
        }),
      )
      expect(outcome).toEqual({ incomplete: "NoticeIncomplete", before: false, after: true })
    })
  })
}
