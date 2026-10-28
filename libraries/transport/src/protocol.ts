/**
 * The room and relay protocol (docs/protocol.md): control messages as JSON text frames, parcel units as binary
 * frames with a 9-byte prefix. Decoding never throws; it returns a Result.
 */
import { Data, Result, Schema } from "effect"

const hex64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const sequence = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffffffff }))
const recordIndex = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffffffff }))
const role = Schema.Literals(["sender", "recipient"])

export const Join = Schema.Struct({ type: Schema.Literal("join"), role, roomToken: hex64 })
export const Joined = Schema.Struct({
  type: Schema.Literal("joined"),
  participantIdentifier: Schema.String,
  senderPresent: Schema.Boolean,
  recipientCount: Schema.Int,
})
export const Peer = Schema.Struct({ type: Schema.Literal("peer"), event: Schema.Literals(["joined", "left"]), role })
export const ErrorMessage = Schema.Struct({ type: Schema.Literal("error"), reason: Schema.String })
export const Accept = Schema.Struct({ type: Schema.Literal("accept"), sequence, digest: hex64 })
export const Decline = Schema.Struct({ type: Schema.Literal("decline"), sequence })
export const Credit = Schema.Struct({ type: Schema.Literal("credit"), records: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 })) })
export const Want = Schema.Struct({
  type: Schema.Literal("want"),
  sequence,
  ranges: Schema.Array(Schema.Tuple([recordIndex, recordIndex])).check(Schema.isMaxLength(1024)),
})
export const Complete = Schema.Struct({ type: Schema.Literal("complete"), sequence })
export const Abort = Schema.Struct({ type: Schema.Literal("abort"), reason: Schema.String.check(Schema.isMaxLength(200)) })

export const ControlMessage = Schema.Union([Join, Joined, Peer, ErrorMessage, Accept, Decline, Credit, Want, Complete, Abort])
export type ControlMessage = typeof ControlMessage.Type
export type Role = typeof role.Type

/** Messages a room relays from recipients to the sender without reading them. */
export const recipientToSenderTypes: ReadonlyArray<ControlMessage["type"]> = ["accept", "decline", "credit", "want", "complete", "abort"]

export class ProtocolError extends Data.TaggedError("ProtocolError")<{ readonly reason: string }> {}

const decodeControl = Schema.decodeUnknownResult(Schema.fromJsonString(ControlMessage))

export const decodeControlMessage = (text: string): Result.Result<ControlMessage, ProtocolError> =>
  Result.mapError(decodeControl(text), (issue) => new ProtocolError({ reason: `not a control message: ${String(issue)}` }))

export const encodeControlMessage = (message: ControlMessage): string => JSON.stringify(message)

export const unitKind = { header: 1, manifestRecord: 2, labelPage: 3, dataRecord: 4 } as const
export type UnitKind = keyof typeof unitKind
const kindByCode = new Map<number, UnitKind>(Object.entries(unitKind).map(([name, code]) => [code, name as UnitKind]))

export const unitPrefixLength = 9

export interface Unit {
  readonly kind: UnitKind
  readonly sequence: number
  readonly index: number
  readonly bytes: Uint8Array
}

export const encodeUnit = (unit: Unit): Uint8Array<ArrayBuffer> => {
  const frame = new Uint8Array(unitPrefixLength + unit.bytes.length)
  const view = new DataView(frame.buffer)
  view.setUint8(0, unitKind[unit.kind])
  view.setUint32(1, unit.sequence)
  view.setUint32(5, unit.index)
  frame.set(unit.bytes, unitPrefixLength)
  return frame
}

export const decodeUnit = (frame: Uint8Array): Result.Result<Unit, ProtocolError> => {
  if (frame.length < unitPrefixLength) return Result.fail(new ProtocolError({ reason: "frame shorter than its prefix" }))
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const kind = kindByCode.get(view.getUint8(0))
  if (kind === undefined) return Result.fail(new ProtocolError({ reason: `unknown unit kind ${view.getUint8(0)}` }))
  return Result.succeed({ kind, sequence: view.getUint32(1), index: view.getUint32(5), bytes: frame.subarray(unitPrefixLength) })
}
