/**
 * Pure room logic (docs/protocol.md): given the socket an event arrived on and the admitted participants, decide what
 * the room does. No I/O, no clock, no randomness, no Effect runtime: the Durable Object adapter (roomObject.ts) loads
 * the room record, hashes tokens, draws identifiers and carries out the instructions this module returns.
 *
 * The one invariant: the room sees room token hashes, roles and message types. It forwards control messages as the
 * text it received and binary frames as the bytes it received, and never decodes or stores either.
 */
import { constantTimeEqual, encodeBase64Url } from "@file-transfer/parcel"
import { decodeControlMessage, encodeControlMessage, recipientToSenderTypes, type Role } from "@file-transfer/transport"
import { Result, Schema } from "effect"

/** Written once at creation; the only thing a room stores. */
export interface RoomRecord {
  readonly roomTokenHash: string
  readonly maximumRecipients: number
}

export const maximumRecipientsLimit = 16

/** The body of `POST /api/rooms`. */
export const CreateRoom = Schema.Struct({
  roomTokenHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  maximumRecipients: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumRecipientsLimit })),
})

const decodeCreateRoomResult = Schema.decodeUnknownResult(CreateRoom)

/** Validates a parsed creation body; the record keeps only the two fields the schema names. */
export const decodeCreateRoom = (body: unknown): RoomRecord | undefined => {
  const result = decodeCreateRoomResult(body)
  return Result.isSuccess(result) ? { roomTokenHash: result.success.roomTokenHash, maximumRecipients: result.success.maximumRecipients } : undefined
}

/** 16 random bytes in unpadded base64url. */
export const roomIdentifierPattern = /^[A-Za-z0-9_-]{22}$/

/** Encodes 16 random bytes as a room identifier. */
export const encodeRoomIdentifier = (bytes: Uint8Array): string => encodeBase64Url(bytes)

/** What a socket carries across hibernation, in its attachment. */
export type Attachment = { readonly admitted: false } | { readonly admitted: true; readonly role: Role; readonly participantIdentifier: string }

export interface Participant {
  readonly role: Role
  readonly participantIdentifier: string
}

/** What the adapter gathers for a join before deciding: the record, the hash of the presented token and a fresh identifier. */
export interface Admission {
  readonly record: RoomRecord
  /** SHA-256 of the join's roomToken bytes, lowercase hex (`hashRoomToken` in libraries/parcel). */
  readonly presentedTokenHash: string
  readonly participantIdentifier: string
}

export type RoomEvent =
  /** A text frame; `admission` is present when the adapter recognised a join (see `joinTokenOf`). */
  { readonly type: "text"; readonly text: string; readonly admission?: Admission } | { readonly type: "binary" } | { readonly type: "close" }

export type Instruction =
  /** Store this in the acting socket's attachment: it is now a participant. */
  | { readonly type: "admit"; readonly participant: Participant }
  /** Send text to the acting socket. */
  | { readonly type: "reply"; readonly text: string }
  /** Send text to these participants. */
  | { readonly type: "relay"; readonly to: ReadonlyArray<string>; readonly text: string }
  /** Forward the binary frame unchanged to these participants. */
  | { readonly type: "forwardFrame"; readonly to: ReadonlyArray<string> }
  /** Close the acting socket. */
  | { readonly type: "close"; readonly code: number; readonly reason: string }

/** Close code for every protocol violation (RFC 6455: policy violation). */
export const violationCloseCode = 1008

/** Longest text frame the room accepts, in UTF-16 code units; a `want` with 1024 ranges of two u32 values fits in about 23,000. */
export const maximumTextLength = 64 * 1024

export const errorReasons = {
  joinFirst: "join first",
  notAJoin: "the first message must be a valid join",
  alreadyJoined: "already joined",
  wrongToken: "wrong room token",
  senderPresent: "a sender is already present",
  roomFull: "the room is full",
  framesFromSenderOnly: "only the sender sends binary frames",
  notAControlMessage: "not a control message",
  textTooLong: "control message too long",
  notAllowedForSender: "the sender may only send abort",
  notAllowedForRecipient: "recipients may only send accept, decline, credit, want, complete or abort",
} as const

const violation = (reason: string): ReadonlyArray<Instruction> => [
  { type: "reply", text: encodeControlMessage({ type: "error", reason }) },
  { type: "close", code: violationCloseCode, reason },
]

const identifiersOf = (participants: ReadonlyArray<Participant>, role: Role): ReadonlyArray<string> =>
  participants.filter((participant) => participant.role === role).map((participant) => participant.participantIdentifier)

const opposite = (role: Role): Role => (role === "sender" ? "recipient" : "sender")

/** Reads only the `type` of an admitted participant's control message; the room forwards the text as is. */
const messageType = (text: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    const type: unknown = (parsed as { readonly type?: unknown }).type
    return typeof type === "string" ? type : undefined
  } catch {
    return undefined
  }
}

/** The roomToken of a text frame that is a valid join, so the adapter knows to hash it before deciding. */
export const joinTokenOf = (text: string): string | undefined => {
  if (text.length > maximumTextLength) return undefined
  const decoded = decodeControlMessage(text)
  return Result.isSuccess(decoded) && decoded.success.type === "join" ? decoded.success.roomToken : undefined
}

const join = (participants: ReadonlyArray<Participant>, role: Role, admission: Admission): ReadonlyArray<Instruction> => {
  if (!constantTimeEqual(admission.presentedTokenHash, admission.record.roomTokenHash)) return violation(errorReasons.wrongToken)
  const senderPresent = participants.some((participant) => participant.role === "sender")
  const recipientCount = participants.length - (senderPresent ? 1 : 0)
  if (role === "sender" && senderPresent) return violation(errorReasons.senderPresent)
  if (role === "recipient" && recipientCount >= admission.record.maximumRecipients) return violation(errorReasons.roomFull)
  const { participantIdentifier } = admission
  const others = identifiersOf(participants, opposite(role))
  const instructions: Array<Instruction> = [
    { type: "admit", participant: { role, participantIdentifier } },
    {
      type: "reply",
      text: encodeControlMessage({
        type: "joined",
        participantIdentifier,
        senderPresent: senderPresent || role === "sender",
        recipientCount: recipientCount + (role === "recipient" ? 1 : 0),
      }),
    },
  ]
  if (others.length > 0) instructions.push({ type: "relay", to: others, text: encodeControlMessage({ type: "peer", event: "joined", role }) })
  return instructions
}

/**
 * Decides one event. `self` is the acting socket's attachment; `participants` are the admitted participants. The list
 * may include the acting socket itself: every lookup filters by the opposite role or happens before it is admitted.
 */
export const decide = (self: Attachment, participants: ReadonlyArray<Participant>, event: RoomEvent): ReadonlyArray<Instruction> => {
  switch (event.type) {
    case "close": {
      if (!self.admitted) return []
      const others = identifiersOf(participants, opposite(self.role))
      return others.length === 0 ? [] : [{ type: "relay", to: others, text: encodeControlMessage({ type: "peer", event: "left", role: self.role }) }]
    }
    case "binary": {
      if (!self.admitted) return violation(errorReasons.joinFirst)
      if (self.role !== "sender") return violation(errorReasons.framesFromSenderOnly)
      return [{ type: "forwardFrame", to: identifiersOf(participants, "recipient") }]
    }
    case "text": {
      if (event.text.length > maximumTextLength) return violation(errorReasons.textTooLong)
      if (!self.admitted) {
        const decoded = decodeControlMessage(event.text)
        if (Result.isFailure(decoded) || decoded.success.type !== "join" || event.admission === undefined) return violation(errorReasons.notAJoin)
        return join(participants, decoded.success.role, event.admission)
      }
      const type = messageType(event.text)
      if (type === undefined) return violation(errorReasons.notAControlMessage)
      if (type === "join") return violation(errorReasons.alreadyJoined)
      if (self.role === "sender") {
        if (type !== "abort") return violation(errorReasons.notAllowedForSender)
        const recipients = identifiersOf(participants, "recipient")
        return recipients.length === 0 ? [] : [{ type: "relay", to: recipients, text: event.text }]
      }
      if (!(recipientToSenderTypes as ReadonlyArray<string>).includes(type)) return violation(errorReasons.notAllowedForRecipient)
      const sender = identifiersOf(participants, "sender")
      return sender.length === 0 ? [] : [{ type: "relay", to: sender, text: event.text }]
    }
  }
}
