/**
 * One interface over every path a transfer can take (direct WebRTC, relayed
 * WebSocket, later stored and seeded). Records are the unit of resume; frames
 * are the unit a path carries. Implementations arrive in milestone M2.
 */
import type { Stream } from "effect"
import { Data, Effect } from "effect"

export type PathKind = "direct" | "relayed"

export interface Frame {
  readonly recordIndex: number
  readonly frameIndex: number
  readonly isLastFrameOfRecord: boolean
  readonly bytes: Uint8Array
}

export class PathClosed extends Data.TaggedError("PathClosed")<{ readonly kind: PathKind; readonly reason: string }> {}

export interface Transport {
  readonly kind: PathKind
  /** Sends a frame once the path has capacity; never buffers without bound. */
  readonly send: (frame: Frame) => Effect.Effect<void, PathClosed>
  /** Frames as they arrive, in the order the path delivers them. */
  readonly receive: Stream.Stream<Frame, PathClosed>
  readonly close: Effect.Effect<void>
}

export class InvalidFrameSize extends Data.TaggedError("InvalidFrameSize")<{ readonly maximumFrameBytes: number }> {}

/** Splits a ciphertext record into frames no larger than `maximumFrameBytes`, which must be a positive integer. */
export const frameRecord = (recordIndex: number, record: Uint8Array, maximumFrameBytes: number): Effect.Effect<readonly Frame[], InvalidFrameSize> => {
  if (!Number.isInteger(maximumFrameBytes) || maximumFrameBytes < 1) {
    return Effect.fail(new InvalidFrameSize({ maximumFrameBytes }))
  }

  const frames: Frame[] = []
  const count = Math.max(1, Math.ceil(record.length / maximumFrameBytes))

  for (let frameIndex = 0; frameIndex < count; frameIndex++) {
    const start = frameIndex * maximumFrameBytes
    frames.push({
      recordIndex,
      frameIndex,
      isLastFrameOfRecord: frameIndex === count - 1,
      bytes: record.subarray(start, Math.min(start + maximumFrameBytes, record.length)),
    })
  }

  return Effect.succeed(frames)
}

/** Reassembles the frames of one record, in frame order. */
export const assembleRecord = (frames: readonly Frame[]): Uint8Array => {
  const ordered = [...frames].toSorted((left, right) => left.frameIndex - right.frameIndex)
  const total = ordered.reduce((sum, frame) => sum + frame.bytes.length, 0)
  const record = new Uint8Array(total)
  let offset = 0

  for (const frame of ordered) {
    record.set(frame.bytes, offset)
    offset += frame.bytes.length
  }

  return record
}

export {
  Abort,
  Accept,
  Complete,
  ControlMessage,
  Credit,
  Decline,
  decodeControlMessage,
  decodeUnit,
  encodeControlMessage,
  encodeUnit,
  ErrorMessage,
  Join,
  Joined,
  Peer,
  pingFrame,
  pongFrame,
  recipientToSenderTypes,
  senderToRecipientTypes,
  unitKind,
  unitPrefixLength,
  Want,
} from "./protocol.ts"

export type { Decoded, Role, Unit, UnitKind } from "./protocol.ts"
