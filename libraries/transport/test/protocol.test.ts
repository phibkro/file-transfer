import { Result } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import { decodeControlMessage, decodeUnit, encodeControlMessage, encodeUnit, unitKind } from "../src/index.ts"
import type { ControlMessage, UnitKind } from "../src/index.ts"

const hex = "ab".repeat(32)

describe("control messages", () => {
  it("round trip", () => {
    const messages: readonly ControlMessage[] = [
      { type: "join", role: "sender", roomToken: hex },
      { type: "joined", participantIdentifier: "p1", senderPresent: true, recipientCount: 1 },
      { type: "peer", event: "left", role: "recipient" },
      { type: "error", reason: "room-full" },
      { type: "accept", sequence: 0, digest: hex },
      { type: "decline", sequence: 3 },
      { type: "credit", records: 64 },
      {
        type: "want",
        sequence: 0,
        ranges: [
          [0, 10],
          [20, 21],
        ],
      },
      { type: "complete", sequence: 0 },
      { type: "abort", reason: "breach" },
    ]

    for (const message of messages) {
      const decoded = decodeControlMessage(encodeControlMessage(message))
      expect(Result.isSuccess(decoded) ? decoded.success : decoded.failure).toEqual(message)
    }
  })

  it("rejects malformed messages instead of throwing", () => {
    for (const text of [
      "not json",
      "{}",
      '{"type":"teleport"}',
      `{"type":"join","role":"sender","roomToken":"${hex.toUpperCase()}"}`,
      `{"type":"join","role":"admin","roomToken":"${hex}"}`,
      '{"type":"credit","records":0}',
      '{"type":"credit","records":1.5}',
      '{"type":"accept","sequence":-1,"digest":"ab"}',
    ]) {
      expect(Result.isFailure(decodeControlMessage(text))).toBe(true)
    }
  })
})

describe("parcel units", () => {
  const kinds = Object.keys(unitKind) as readonly UnitKind[]

  it("round trip for any kind, sequence, index and payload", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...kinds),
        fc.integer({ min: 0, max: 0xff_ff_ff_ff }),
        fc.integer({ min: 0, max: 0xff_ff_ff_ff }),
        fc.uint8Array({ maxLength: 300 }),
        (kind, sequence, index, bytes) => {
          const decoded = decodeUnit(encodeUnit({ kind, sequence, index, bytes }))
          expect(Result.isSuccess(decoded)).toBe(true)

          if (Result.isSuccess(decoded)) {
            expect({ ...decoded.success, bytes: Array.from(decoded.success.bytes) }).toEqual({ kind, sequence, index, bytes: Array.from(bytes) })
          }
        },
      ),
    )
  })

  it("rejects short frames and unknown kinds", () => {
    expect(Result.isFailure(decodeUnit(new Uint8Array(8)))).toBe(true)
    expect(Result.isFailure(decodeUnit(new Uint8Array(9)))).toBe(true)
    const frame = encodeUnit({ kind: "header", sequence: 0, index: 0, bytes: new Uint8Array(3) })
    frame[0] = 9
    expect(Result.isFailure(decodeUnit(frame))).toBe(true)
  })
})
