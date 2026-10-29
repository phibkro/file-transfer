import * as fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import { ControlMessage, decodeControlMessage, decodeUnit, encodeControlMessage, encodeUnit, unitKind } from "../src/index.ts"
import type { UnitKind } from "../src/index.ts"

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
      expect(decoded.ok ? decoded.value : decoded.reason).toEqual(message)
    }
  })

  it("drops unknown keys, so newer peers may add fields", () => {
    const decoded = decodeControlMessage(JSON.stringify({ type: "credit", records: 8, priority: "high" }))
    expect(decoded.ok ? decoded.value : decoded.reason).toEqual({ type: "credit", records: 8 })
  })

  it("refuses integers JavaScript cannot represent exactly", () => {
    expect(decodeControlMessage('{"type":"joined","participantIdentifier":"p","senderPresent":false,"recipientCount":-9007199254740992}').ok).toBe(false)
  })

  it("is a Standard Schema, so any consumer can validate through `~standard`", async () => {
    const standard = ControlMessage["~standard"]
    expect(standard.version).toBe(1)
    expect(await standard.validate({ type: "decline", sequence: 2 })).toMatchObject({ value: { type: "decline", sequence: 2 } })
    expect("issues" in (await standard.validate({ type: "decline", sequence: -1 }))).toBe(true)
  })

  it("never throws on arbitrary text", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        expect(() => decodeControlMessage(text)).not.toThrow()
      }),
    )
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
      expect(decodeControlMessage(text).ok).toBe(false)
    }
  })
})

describe("parcel units", () => {
  // SAFETY: the keys of the const object unitKind are exactly the UnitKind names.
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
          expect(decoded.ok).toBe(true)

          if (decoded.ok) {
            expect({ ...decoded.value, bytes: Array.from(decoded.value.bytes) }).toEqual({ kind, sequence, index, bytes: Array.from(bytes) })
          }
        },
      ),
    )
  })

  it("rejects short frames and unknown kinds", () => {
    expect(decodeUnit(new Uint8Array(8)).ok).toBe(false)
    expect(decodeUnit(new Uint8Array(9)).ok).toBe(false)
    const frame = encodeUnit({ kind: "header", sequence: 0, index: 0, bytes: new Uint8Array(3) })
    frame[0] = 9
    expect(decodeUnit(frame).ok).toBe(false)
  })
})
