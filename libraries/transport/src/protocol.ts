/**
 * The room and relay protocol (docs/protocol.md): control messages as JSON text frames, parcel units as binary
 * frames with a 9-byte prefix. Decoding never throws; it returns a `Decoded` value.
 *
 * The control messages are defined once, with Valibot, and the schema is a Standard Schema (standardschema.dev), so
 * any consumer reads it through that interface: the browser directly, Effect code through `~standard.validate`. The
 * browser imports this file only (`@file-transfer/transport/protocol`), never Effect: Valibot's validators for this
 * contract weigh about 8 KB against about 76 KB of Effect Schema (docs/decisions/0020-wire-contracts-in-standard-schema.md).
 */
import * as v from "valibot"

const hex64 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u))
const u32 = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(0xff_ff_ff_ff))
const role = v.picklist(["sender", "recipient"])

// `object`, not `strictObject`: unknown keys are dropped, so a newer peer may add fields an older one ignores.
export const Join = v.object({ type: v.literal("join"), role, roomToken: hex64 })

export const Joined = v.object({
  type: v.literal("joined"),
  participantIdentifier: v.string(),
  senderPresent: v.boolean(),
  recipientCount: v.pipe(v.number(), v.safeInteger()),
})

export const Peer = v.object({ type: v.literal("peer"), event: v.picklist(["joined", "left"]), role })
export const ErrorMessage = v.object({ type: v.literal("error"), reason: v.string() })
export const Accept = v.object({ type: v.literal("accept"), sequence: u32, digest: hex64 })
export const Decline = v.object({ type: v.literal("decline"), sequence: u32 })
export const Credit = v.object({ type: v.literal("credit"), records: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(4096)) })

export const Want = v.object({
  type: v.literal("want"),
  sequence: u32,
  ranges: v.pipe(v.array(v.pipe(v.tuple([u32, u32]), v.readonly())), v.maxLength(1024), v.readonly()),
})

export const Complete = v.object({ type: v.literal("complete"), sequence: u32 })
export const Abort = v.object({ type: v.literal("abort"), reason: v.pipe(v.string(), v.maxLength(200)) })

/** Every control message, as one schema; a Standard Schema through its `~standard` property. */
export const ControlMessage = v.variant("type", [Join, Joined, Peer, ErrorMessage, Accept, Decline, Credit, Want, Complete, Abort])

export type ControlMessage = v.InferOutput<typeof ControlMessage>

export type Role = v.InferOutput<typeof role>

/** Messages a room relays from recipients to the sender without reading them. */
export const recipientToSenderTypes: readonly ControlMessage["type"][] = ["accept", "decline", "credit", "want", "complete", "abort"]

/** The outcome of decoding untrusted input: the value, or why it was refused. */
export type Decoded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }

const refuse = <T>(reason: string): Decoded<T> => ({ ok: false, reason })

/** Parses and validates one control message; anything else is refused with a reason, never thrown. */
export const decodeControlMessage = (text: string): Decoded<ControlMessage> => {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    return refuse("not a control message: not JSON")
  }

  const result = v.safeParse(ControlMessage, parsed)

  return result.success ? { ok: true, value: result.output } : refuse(`not a control message: ${result.issues[0].message}`)
}

export const encodeControlMessage = (message: ControlMessage): string => JSON.stringify(message)

export const unitKind = { header: 1, manifestRecord: 2, labelPage: 3, dataRecord: 4 } as const

export type UnitKind = keyof typeof unitKind

// SAFETY: the keys of the const object unitKind are exactly the UnitKind names.
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

export const decodeUnit = (frame: Uint8Array): Decoded<Unit> => {
  if (frame.length < unitPrefixLength) {
    return refuse("frame shorter than its prefix")
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const kind = kindByCode.get(view.getUint8(0))

  if (kind === undefined) {
    return refuse(`unknown unit kind ${view.getUint8(0)}`)
  }

  return { ok: true, value: { kind, sequence: view.getUint32(1), index: view.getUint32(5), bytes: frame.subarray(unitPrefixLength) } }
}
