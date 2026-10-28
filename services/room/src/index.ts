/**
 * Rooms pair one sender with recipients and carry signaling. A room knows only
 * the SHA-256 of its room token, never the link secret.
 */
import { constantTimeEqual, hashRoomToken } from "@file-transfer/format"
import { Context, Data, Effect, Layer, Ref } from "effect"

export type RoomIdentifier = string
export type ParticipantIdentifier = string
export type Role = "sender" | "recipient"

export interface RoomDescription {
  readonly roomIdentifier: RoomIdentifier
  readonly isClosed: boolean
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

interface RoomState {
  readonly roomTokenHash: string
  readonly maximumRecipients: number
  readonly isClosed: boolean
  readonly participants: ReadonlyMap<ParticipantIdentifier, Role>
}

const randomIdentifier = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const describeState = (roomIdentifier: RoomIdentifier, state: RoomState): RoomDescription => {
  const roles = [...state.participants.values()]
  return {
    roomIdentifier,
    isClosed: state.isClosed,
    hasSender: roles.includes("sender"),
    recipientCount: roles.filter((role) => role === "recipient").length,
    maximumRecipients: state.maximumRecipients,
  }
}

/** In-memory reference layer: the executable model every platform must match. */
export const RoomReference = Layer.effect(
  Room,
  Effect.gen(function* () {
    const rooms = yield* Ref.make<ReadonlyMap<RoomIdentifier, RoomState>>(new Map())

    const lookup = (roomIdentifier: RoomIdentifier) =>
      Effect.flatMap(Ref.get(rooms), (all) => {
        const state = all.get(roomIdentifier)
        return state === undefined ? Effect.fail(new RoomNotFound({ roomIdentifier })) : Effect.succeed(state)
      })

    const store = (roomIdentifier: RoomIdentifier, state: RoomState) =>
      Ref.update(rooms, (all) => new Map(all).set(roomIdentifier, state))

    return {
      create: ({ roomTokenHash, maximumRecipients }) =>
        Effect.gen(function* () {
          const roomIdentifier = randomIdentifier()
          yield* store(roomIdentifier, { roomTokenHash, maximumRecipients, isClosed: false, participants: new Map() })
          return roomIdentifier
        }),

      join: ({ roomIdentifier, roomToken, role }) =>
        Effect.gen(function* () {
          const state = yield* lookup(roomIdentifier)
          if (state.isClosed) return yield* Effect.fail(new RoomClosed({ roomIdentifier }))
          const presentedHash = yield* Effect.promise(() => hashRoomToken(roomToken))
          if (!constantTimeEqual(presentedHash, state.roomTokenHash)) {
            return yield* Effect.fail(new RoomTokenRejected({ roomIdentifier }))
          }
          const description = describeState(roomIdentifier, state)
          const isFull = role === "sender" ? description.hasSender : description.recipientCount >= state.maximumRecipients
          if (isFull) return yield* Effect.fail(new RoomFull({ roomIdentifier, role }))
          const participantIdentifier = randomIdentifier()
          yield* store(roomIdentifier, { ...state, participants: new Map(state.participants).set(participantIdentifier, role) })
          return participantIdentifier
        }),

      leave: ({ roomIdentifier, participantIdentifier }) =>
        Effect.gen(function* () {
          const state = yield* lookup(roomIdentifier)
          const participants = new Map(state.participants)
          participants.delete(participantIdentifier)
          yield* store(roomIdentifier, { ...state, participants })
        }),

      close: (roomIdentifier) =>
        Effect.gen(function* () {
          const state = yield* lookup(roomIdentifier)
          yield* store(roomIdentifier, { ...state, isClosed: true })
        }),

      describe: (roomIdentifier) => Effect.map(lookup(roomIdentifier), (state) => describeState(roomIdentifier, state)),
    }
  }),
)
