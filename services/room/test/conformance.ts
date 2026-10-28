/**
 * Conformance suite for the Room service. Every platform layer must pass it,
 * alongside the reference layer. Run it with `roomConformance(name, layer)`.
 */
import { deriveRoomToken, hashRoomToken } from "@file-transfer/format"
import { describe, expect, it } from "bun:test"
import { Effect, type Layer } from "effect"
import fc from "fast-check"
import { Room } from "../src/index.ts"

const secretArbitrary = fc.uint8Array({ minLength: 32, maxLength: 32 })

const createRoomWithSecret = (secret: Uint8Array, maximumRecipients: number) =>
  Effect.gen(function* () {
    const room = yield* Room
    const roomToken = yield* Effect.promise(() => deriveRoomToken(secret))
    const roomTokenHash = yield* Effect.promise(() => hashRoomToken(roomToken))
    const roomIdentifier = yield* room.create({ roomTokenHash, maximumRecipients })
    return { room, roomToken, roomIdentifier }
  })

export const roomConformance = (name: string, layer: Layer.Layer<Room>) => {
  const run = <A, E>(effect: Effect.Effect<A, E, Room>) => Effect.runPromise(Effect.provide(effect, layer))

  describe(`Room conformance: ${name}`, () => {
    it("admits exactly the holder of the room token", async () => {
      await fc.assert(
        fc.asyncProperty(secretArbitrary, secretArbitrary, async (secret, otherSecret) => {
          fc.pre(secret.some((byte, index) => byte !== otherSecret[index]))
          const outcome = await run(
            Effect.gen(function* () {
              const { room, roomToken, roomIdentifier } = yield* createRoomWithSecret(secret, 4)
              const otherToken = yield* Effect.promise(() => deriveRoomToken(otherSecret))
              const rejected = yield* Effect.flip(room.join({ roomIdentifier, roomToken: otherToken, role: "recipient" }))
              const admitted = yield* room.join({ roomIdentifier, roomToken, role: "recipient" })
              return { rejected: rejected._tag, admitted }
            }),
          )
          expect(outcome.rejected).toBe("RoomTokenRejected")
          expect(typeof outcome.admitted).toBe("string")
        }),
        { numRuns: 25 },
      )
    })

    it("allows one sender and at most the maximum number of recipients", async () => {
      await fc.assert(
        fc.asyncProperty(secretArbitrary, fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 9 }), async (secret, maximumRecipients, attempts) => {
          const outcome = await run(
            Effect.gen(function* () {
              const { room, roomToken, roomIdentifier } = yield* createRoomWithSecret(secret, maximumRecipients)
              yield* room.join({ roomIdentifier, roomToken, role: "sender" })
              const secondSender = yield* Effect.flip(room.join({ roomIdentifier, roomToken, role: "sender" }))
              let admitted = 0
              let rejectedAsFull = 0
              for (let attempt = 0; attempt < attempts; attempt++) {
                const result = yield* Effect.result(room.join({ roomIdentifier, roomToken, role: "recipient" }))
                if (result._tag === "Success") admitted++
                else if (result.failure._tag === "RoomFull") rejectedAsFull++
              }
              const description = yield* room.describe(roomIdentifier)
              return { secondSender: secondSender._tag, admitted, rejectedAsFull, description }
            }),
          )
          expect(outcome.secondSender).toBe("RoomFull")
          expect(outcome.admitted).toBe(Math.min(attempts, maximumRecipients))
          expect(outcome.rejectedAsFull).toBe(Math.max(0, attempts - maximumRecipients))
          expect(outcome.description.recipientCount).toBe(outcome.admitted)
          expect(outcome.description.hasSender).toBe(true)
        }),
        { numRuns: 25 },
      )
    })

    it("rejects joins after the room is closed", async () => {
      const tag = await run(
        Effect.gen(function* () {
          const { room, roomToken, roomIdentifier } = yield* createRoomWithSecret(new Uint8Array(32).fill(1), 2)
          yield* room.close(roomIdentifier)
          const error = yield* Effect.flip(room.join({ roomIdentifier, roomToken, role: "recipient" }))
          return error._tag
        }),
      )
      expect(tag).toBe("RoomClosed")
    })

    it("reports unknown rooms as not found", async () => {
      const tag = await run(
        Effect.gen(function* () {
          const room = yield* Room
          const error = yield* Effect.flip(room.describe("no-such-room"))
          return error._tag
        }),
      )
      expect(tag).toBe("RoomNotFound")
    })

    it("gives every room a distinct identifier", async () => {
      const identifiers = await run(
        Effect.gen(function* () {
          const room = yield* Room
          return yield* Effect.forEach(Array.from({ length: 200 }), () => room.create({ roomTokenHash: "00", maximumRecipients: 1 }))
        }),
      )
      expect(new Set(identifiers).size).toBe(identifiers.length)
    })
  })
}
