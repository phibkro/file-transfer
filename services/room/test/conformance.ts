/**
 * The Room service's conformance suite: one check per guarantee in `roomGuarantees`. Every platform layer runs
 * `roomSuite.run` and `roomSuite.negativeControls` with its own broken variants, as the reference layer does.
 */
import { conformanceSuite, transitionTableCheck } from "@file-transfer/conformance"
import * as Machine from "@file-transfer/machine"
import { deriveRoomToken, hashRoomToken } from "@file-transfer/parcel"
import { expect } from "vite-plus/test"
import { Effect } from "effect"
import type { Layer } from "effect"
import * as fc from "fast-check"
import { Room, roomGuarantees, roomMachine } from "../src/index.ts"
import type { RoomGuarantee, RoomState } from "../src/index.ts"

const secretArbitrary = fc.uint8Array({ minLength: 32, maxLength: 32 })

const createRoomWithSecret = (secret: Uint8Array, maximumRecipients: number) =>
  Effect.gen(function* () {
    const room = yield* Room
    const roomToken = yield* Effect.promise(async () => await deriveRoomToken(secret))
    const roomTokenHash = yield* Effect.promise(async () => await hashRoomToken(roomToken))
    const roomIdentifier = yield* room.create({ roomTokenHash, maximumRecipients })

    return { room, roomToken, roomIdentifier }
  })

interface RoomHandle {
  readonly roomIdentifier: string
  readonly roomToken: Uint8Array
}

const fixedSecret = new Uint8Array(32).fill(7)

const openRoom = Effect.map(createRoomWithSecret(fixedSecret, 4), ({ roomIdentifier, roomToken }): RoomHandle => ({ roomIdentifier, roomToken }))

/** Drives the room through every pair of its machine's table. */
const followsMachine = transitionTableCheck(roomMachine, {
  arrange: (state) =>
    Effect.gen(function* () {
      if (state === Machine.boundary) {
        const handle = yield* openRoom

        return { ...handle, roomIdentifier: "no-such-room" }
      }

      const handle = yield* openRoom

      if (state === "Closed") {
        const room = yield* Room
        yield* Effect.orDie(room.close(handle.roomIdentifier))
      }

      return handle
    }),
  apply: {
    createRoom: () => openRoom,
    joinRoom: (handle) =>
      Effect.gen(function* () {
        const room = yield* Room
        yield* room.join({ ...handle, role: "recipient" })

        return handle
      }),
    leaveRoom: (handle) =>
      Effect.gen(function* () {
        const room = yield* Room
        yield* room.leave({ roomIdentifier: handle.roomIdentifier, participantIdentifier: "nobody" })

        return handle
      }),
    closeRoom: (handle) =>
      Effect.gen(function* () {
        const room = yield* Room
        yield* room.close(handle.roomIdentifier)

        return handle
      }),
  },
  observe: (handle) =>
    Effect.gen(function* () {
      const room = yield* Room

      return yield* Effect.match(room.describe(handle.roomIdentifier), {
        onFailure: (): RoomState | Machine.Boundary => Machine.boundary,
        onSuccess: (description) => description.state,
      })
    }),
  inexpressible: [
    { state: "Open", command: "createRoom", reason: "creating always makes a new room; nothing names an existing one" },
    { state: "Closed", command: "createRoom", reason: "creating always makes a new room; nothing names an existing one" },
  ],
})

const runner =
  (layer: Layer.Layer<Room>) =>
  async <A, E>(effect: Effect.Effect<A, E, Room>) =>
    await Effect.runPromise(Effect.provide(effect, layer))

export const roomSuite = conformanceSuite<Room, RoomGuarantee>({
  service: "Room",
  guarantees: roomGuarantees,
  checks: {
    "room/token-admission": async (layer) => {
      await fc.assert(
        fc.asyncProperty(secretArbitrary, secretArbitrary, async (secret, otherSecret) => {
          fc.pre(secret.some((byte, index) => byte !== otherSecret[index]))

          const outcome = await runner(layer)(
            Effect.gen(function* () {
              const { room, roomToken, roomIdentifier } = yield* createRoomWithSecret(secret, 4)
              const otherToken = yield* Effect.promise(async () => await deriveRoomToken(otherSecret))
              const wrongToken = yield* Effect.result(room.join({ roomIdentifier, roomToken: otherToken, role: "recipient" }))
              const rightToken = yield* Effect.result(room.join({ roomIdentifier, roomToken, role: "recipient" }))

              return { wrongToken: wrongToken._tag === "Failure" ? wrongToken.failure._tag : "admitted", rightToken: rightToken._tag }
            }),
          )

          expect(outcome).toEqual({ wrongToken: "RoomTokenRejected", rightToken: "Success" })
        }),
        { numRuns: 25 },
      )
    },

    "room/capacity": async (layer) => {
      await fc.assert(
        fc.asyncProperty(secretArbitrary, fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 9 }), async (secret, maximumRecipients, attempts) => {
          const outcome = await runner(layer)(
            Effect.gen(function* () {
              const { room, roomToken, roomIdentifier } = yield* createRoomWithSecret(secret, maximumRecipients)
              yield* room.join({ roomIdentifier, roomToken, role: "sender" })
              const secondSender = yield* Effect.result(room.join({ roomIdentifier, roomToken, role: "sender" }))
              let admitted = 0

              for (let attempt = 0; attempt < attempts; attempt++) {
                const result = yield* Effect.result(room.join({ roomIdentifier, roomToken, role: "recipient" }))

                if (result._tag === "Success") {
                  admitted++
                }
              }

              const description = yield* room.describe(roomIdentifier)

              return { secondSender: secondSender._tag, admitted, description }
            }),
          )

          expect(outcome.secondSender).toBe("Failure")
          expect(outcome.admitted).toBe(Math.min(attempts, maximumRecipients))
          expect(outcome.description.recipientCount).toBe(outcome.admitted)
          expect(outcome.description.hasSender).toBe(true)
        }),
        { numRuns: 25 },
      )
    },

    "room/closed-rejects-joins": async (layer) => {
      const outcome = await runner(layer)(
        Effect.gen(function* () {
          const { room, roomToken, roomIdentifier } = yield* createRoomWithSecret(new Uint8Array(32).fill(1), 2)
          yield* room.close(roomIdentifier)
          const result = yield* Effect.result(room.join({ roomIdentifier, roomToken, role: "recipient" }))
          const description = yield* room.describe(roomIdentifier)

          return { join: result._tag === "Failure" ? result.failure._tag : "admitted", state: description.state }
        }),
      )

      expect(outcome).toEqual({ join: "RoomClosed", state: "Closed" })
    },

    "room/unknown-not-found": async (layer) => {
      const tag = await runner(layer)(
        Effect.gen(function* () {
          const room = yield* Room
          const result = yield* Effect.result(room.describe("no-such-room"))

          return result._tag === "Failure" ? result.failure._tag : "found"
        }),
      )

      expect(tag).toBe("RoomNotFound")
    },

    "room/distinct-identifiers": async (layer) => {
      const identifiers = await runner(layer)(
        Effect.gen(function* () {
          const room = yield* Room

          return yield* Effect.forEach(Array.from({ length: 200 }), () => room.create({ roomTokenHash: "00", maximumRecipients: 1 }))
        }),
      )

      expect(new Set(identifiers).size).toBe(identifiers.length)
    },

    "room/follows-machine": followsMachine,
  },
})
