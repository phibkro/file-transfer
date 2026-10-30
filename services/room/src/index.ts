/**
 * Rooms pair one sender with recipients and carry signaling. A room knows only
 * the SHA-256 of its room token, never the link secret.
 */
import { declareGuarantees } from "@file-transfer/conformance/guarantee"
import { constantTimeEqual, hashRoomToken, toHex } from "@file-transfer/parcel"
import * as Machine from "@file-transfer/machine"
import { Context, Data, Effect, Layer, Ref } from "effect"
import { SecureRandom } from "effect/crypto"

export type RoomIdentifier = string

export type ParticipantIdentifier = string

export type Role = "sender" | "recipient"

export const roomGuarantees = declareGuarantees([
  { identifier: "room/token-admission", property: "a join succeeds only with the room token whose hash created the room", strength: "port-enforced" },
  { identifier: "room/capacity", property: "a room admits one sender and at most its maximum number of recipients", strength: "port-enforced" },
  { identifier: "room/closed-rejects-joins", property: "a closed room admits nobody", strength: "port-enforced" },
  { identifier: "room/unknown-not-found", property: "an unknown room identifier is reported as not found", strength: "port-enforced" },
  { identifier: "room/distinct-identifiers", property: "every created room has an identifier no other room has", strength: "port-enforced" },
  {
    identifier: "room/follows-machine",
    property: "every command in every state, the illegal ones included, does what the room machine's table says",
    strength: "port-enforced",
  },
])

export type RoomGuarantee = (typeof roomGuarantees)[number]["identifier"]

/** The room's life cycle. Joining and leaving do not change it; they are listed so the table says where they may run. */
export const roomMachine = Machine.make({
  name: "Room",
  states: ["Open", "Closed"],
  commands: ["createRoom", "joinRoom", "leaveRoom", "closeRoom"],
  terminal: ["Closed"],
  transitions: [
    { command: "createRoom", from: [Machine.boundary], to: "Open" },
    { command: "joinRoom", from: ["Open"], to: "Open", when: "token matches, capacity left" },
    { command: "leaveRoom", from: ["Open"], to: "Open" },
    { command: "leaveRoom", from: ["Closed"], to: "Closed" },
    { command: "closeRoom", from: ["Open", "Closed"], to: "Closed" },
  ],
})

export type RoomState = (typeof roomMachine.states)[number]

export interface RoomDescription {
  readonly roomIdentifier: RoomIdentifier
  readonly state: RoomState
  readonly hasSender: boolean
  readonly recipientCount: number
  readonly maximumRecipients: number
}

export class RoomNotFound extends Data.TaggedError("RoomNotFound")<{ readonly roomIdentifier: RoomIdentifier }> {}

export class RoomTokenRejected extends Data.TaggedError("RoomTokenRejected")<{ readonly roomIdentifier: RoomIdentifier }> {}

export class RoomFull extends Data.TaggedError("RoomFull")<{ readonly roomIdentifier: RoomIdentifier; readonly role: Role }> {}

export class RoomClosed extends Data.TaggedError("RoomClosed")<{ readonly roomIdentifier: RoomIdentifier }> {}

export type JoinError = RoomNotFound | RoomTokenRejected | RoomFull | RoomClosed

export class Room extends Context.Service<
  Room,
  {
    readonly create: (input: { readonly roomTokenHash: string; readonly maximumRecipients: number }) => Effect.Effect<RoomIdentifier>
    readonly join: (input: {
      readonly roomIdentifier: RoomIdentifier
      readonly roomToken: Uint8Array
      readonly role: Role
    }) => Effect.Effect<ParticipantIdentifier, JoinError>
    readonly leave: (input: {
      readonly roomIdentifier: RoomIdentifier
      readonly participantIdentifier: ParticipantIdentifier
    }) => Effect.Effect<void, RoomNotFound>
    readonly close: (roomIdentifier: RoomIdentifier) => Effect.Effect<void, RoomNotFound>
    readonly describe: (roomIdentifier: RoomIdentifier) => Effect.Effect<RoomDescription, RoomNotFound>
  }
>()("file-transfer/Room") {}

interface RoomRecord {
  readonly roomTokenHash: string
  readonly maximumRecipients: number
  readonly state: RoomState
  readonly participants: ReadonlyMap<ParticipantIdentifier, Role>
}

const describeRecord = (roomIdentifier: RoomIdentifier, record: RoomRecord): RoomDescription => {
  const roles = [...record.participants.values()]

  return {
    roomIdentifier,
    state: record.state,
    hasSender: roles.includes("sender"),
    recipientCount: roles.filter((role) => role === "recipient").length,
    maximumRecipients: record.maximumRecipients,
  }
}

/**
 * The in-memory reference layer: the executable model every platform must match. `faults` builds the deliberately
 * broken variants that the negative controls need; production code always uses `RoomReference`, which has none.
 */
export const makeRoomReference = (faults: ReadonlySet<RoomGuarantee> = new Set()) =>
  Layer.effect(
    Room,
    Effect.gen(function* () {
      const rooms = yield* Ref.make<ReadonlyMap<RoomIdentifier, RoomRecord>>(new Map())
      const random = yield* SecureRandom.SecureRandom
      /** `SecureRandom` cannot fail: a broken source of secure randomness is a defect of the runtime, not an outcome a caller can handle. */
      const randomIdentifier = Effect.map(random.randomBytes(16), toHex)

      const lookup = (roomIdentifier: RoomIdentifier) =>
        Effect.flatMap(Ref.get(rooms), (all) => {
          const record = all.get(roomIdentifier)

          return record === undefined ? Effect.fail(new RoomNotFound({ roomIdentifier })) : Effect.succeed(record)
        })

      const store = (roomIdentifier: RoomIdentifier, record: RoomRecord) => Ref.update(rooms, (all) => new Map(all).set(roomIdentifier, record))

      return {
        create: ({ roomTokenHash, maximumRecipients }) =>
          Effect.gen(function* () {
            const roomIdentifier = faults.has("room/distinct-identifiers") ? "the-same-room" : yield* randomIdentifier
            yield* store(roomIdentifier, { roomTokenHash, maximumRecipients, state: "Open", participants: new Map() })

            return roomIdentifier
          }),

        join: ({ roomIdentifier, roomToken, role }) =>
          Effect.gen(function* () {
            const record = yield* lookup(roomIdentifier)

            if (!faults.has("room/closed-rejects-joins") && !Machine.can(roomMachine, "joinRoom", record.state, undefined)) {
              return yield* new RoomClosed({ roomIdentifier })
            }

            const presentedHash = yield* Effect.promise(() => hashRoomToken(roomToken))

            if (!faults.has("room/token-admission") && !constantTimeEqual(presentedHash, record.roomTokenHash)) {
              return yield* new RoomTokenRejected({ roomIdentifier })
            }

            const description = describeRecord(roomIdentifier, record)
            const isFull = role === "sender" ? description.hasSender : description.recipientCount >= record.maximumRecipients

            if (isFull && !faults.has("room/capacity")) {
              return yield* new RoomFull({ roomIdentifier, role })
            }

            const participantIdentifier = yield* randomIdentifier
            yield* store(roomIdentifier, { ...record, participants: new Map(record.participants).set(participantIdentifier, role) })

            return participantIdentifier
          }),

        leave: ({ roomIdentifier, participantIdentifier }) =>
          Effect.gen(function* () {
            const record = yield* lookup(roomIdentifier)
            const participants = new Map(record.participants)
            participants.delete(participantIdentifier)
            yield* store(roomIdentifier, { ...record, participants })
          }),

        close: (roomIdentifier) =>
          Effect.gen(function* () {
            const record = yield* lookup(roomIdentifier)
            const next = Machine.next(roomMachine, "closeRoom", record.state, undefined)
            const state = next === undefined || next === Machine.boundary || faults.has("room/follows-machine") ? record.state : next
            yield* store(roomIdentifier, { ...record, state })
          }),

        describe: (roomIdentifier) =>
          faults.has("room/unknown-not-found")
            ? Effect.map(Ref.get(rooms), (all) => {
                const record = all.get(roomIdentifier)

                return record === undefined
                  ? { roomIdentifier, state: "Open" as const, hasSender: false, recipientCount: 0, maximumRecipients: 0 }
                  : describeRecord(roomIdentifier, record)
              })
            : Effect.map(lookup(roomIdentifier), (record) => describeRecord(roomIdentifier, record)),
      }
    }),
  )

export const RoomReference = makeRoomReference()
