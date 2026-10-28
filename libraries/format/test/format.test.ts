import { describe, expect, it } from "vite-plus/test"
import fc from "fast-check"
import {
  constantTimeEqual,
  deriveRoomToken,
  hashRoomToken,
  headerLength,
  headerMagic,
  keyCommitmentLength,
  recordSize,
  saltLength,
} from "../src/index.ts"

describe("format v1 constants", () => {
  it("header layout adds up to the documented 54 bytes", () => {
    expect(headerMagic.length + 1 + 1 + saltLength + keyCommitmentLength).toBe(headerLength)
  })

  it("record size is a power of two within the allowed range", () => {
    expect(recordSize(16)).toBe(65536)
    expect(() => recordSize(11)).toThrow()
    expect(() => recordSize(23)).toThrow()
  })
})

describe("room token", () => {
  it("is deterministic and 32 bytes", async () => {
    const secret = new Uint8Array(32).fill(7)
    const first = await deriveRoomToken(secret)
    const second = await deriveRoomToken(secret)
    expect(first.length).toBe(32)
    expect(Array.from(first)).toEqual(Array.from(second))
  })

  it("different secrets give different token hashes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.uint8Array({ minLength: 32, maxLength: 32 }), async (left, right) => {
        fc.pre(left.some((byte, index) => byte !== right[index]))
        const leftHash = await hashRoomToken(await deriveRoomToken(left))
        const rightHash = await hashRoomToken(await deriveRoomToken(right))
        expect(constantTimeEqual(leftHash, rightHash)).toBe(false)
      }),
      { numRuns: 50 },
    )
  })
})
