/** The Abuse service's conformance suite: one check per guarantee in `abuseGuarantees`. */
import { conformanceSuite } from "@file-transfer/conformance"
import { expect } from "bun:test"
import { Effect, type Layer } from "effect"
import fc from "fast-check"
import { Abuse, abuseGuarantees, type AbuseGuarantee, type Notice } from "../src/index.ts"

const runner = (layer: Layer.Layer<Abuse>) => <A, E>(effect: Effect.Effect<A, E, Abuse>) => Effect.runPromise(Effect.provide(effect, layer))

const completeNotice = (location: string): Notice => ({
  location,
  explanation: "illegal content",
  submitterName: "A. Person",
  submitterEmail: "person@example.com",
  statementOfGoodFaith: true,
})

const requiredFields = ["location", "explanation", "submitterName", "submitterEmail"] as const

export const abuseSuite = conformanceSuite<Abuse, AbuseGuarantee>({
  service: "Abuse",
  guarantees: abuseGuarantees,
  checks: {
    "abuse/fragment-never-stored": async (layer) => {
      await fc.assert(
        fc.asyncProperty(fc.webUrl(), fc.string({ minLength: 1 }), async (url, fragment) => {
          const receipt = await runner(layer)(Effect.gen(function* () {
            return yield* (yield* Abuse).submitNotice(completeNotice(`${url}#${fragment}`))
          }))
          expect(receipt.storedLocation).toBe(url)
        }),
        { numRuns: 50 },
      )
    },

    "abuse/complete-notices-only": async (layer) => {
      await fc.assert(
        fc.asyncProperty(fc.subarray([...requiredFields], { minLength: 1 }), fc.constantFrom("", " ", "\t\n"), async (blanked, blank) => {
          const notice = { ...completeNotice("https://host/r/room"), ...Object.fromEntries(blanked.map((field) => [field, blank])) }
          const result = await runner(layer)(Effect.gen(function* () {
            return yield* Effect.result((yield* Abuse).submitNotice(notice))
          }))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect([...result.failure.missing].sort()).toEqual([...blanked].sort())
        }),
        { numRuns: 30 },
      )
    },

    "abuse/revocation-applies": async (layer) => {
      const outcome = await runner(layer)(
        Effect.gen(function* () {
          const abuse = yield* Abuse
          const first = yield* abuse.submitNotice(completeNotice("https://host/r/room-1#secret"))
          const second = yield* abuse.submitNotice(completeNotice("https://host/r/room-2#secret"))
          yield* abuse.decide({ noticeIdentifier: first.noticeIdentifier, decision: { kind: "revoke", roomIdentifier: "room-1", reason: "malware" } })
          yield* abuse.decide({ noticeIdentifier: second.noticeIdentifier, decision: { kind: "reject", reason: "not illegal" } })
          return { room1: yield* abuse.isRevoked("room-1"), room2: yield* abuse.isRevoked("room-2"), room3: yield* abuse.isRevoked("room-3") }
        }),
      )
      expect(outcome).toEqual({ room1: true, room2: false, room3: false })
    },

    "abuse/unknown-notice-not-found": async (layer) => {
      const tag = await runner(layer)(
        Effect.gen(function* () {
          const abuse = yield* Abuse
          const result = yield* Effect.result(abuse.decide({ noticeIdentifier: "no-such-notice", decision: { kind: "reject", reason: "x" } }))
          return result._tag === "Failure" ? result.failure._tag : "decided"
        }),
      )
      expect(tag).toBe("NoticeNotFound")
    },
  },
})
