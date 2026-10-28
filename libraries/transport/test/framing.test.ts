import { expect, it } from "vite-plus/test"
import { Effect } from "effect"
import * as fc from "fast-check"
import { assembleRecord, frameRecord } from "../src/index.ts"

it("framing then assembling returns the original record, in any arrival order", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 4096 }), fc.integer({ min: 1, max: 700 }), fc.integer(), (record, maximumFrameBytes, seed) => {
      const frames = [...Effect.runSync(frameRecord(3, record, maximumFrameBytes))]

      for (let index = frames.length - 1; index > 0; index--) {
        const swap = Math.abs(seed + index) % (index + 1)

        ;[frames[index], frames[swap]] = [frames[swap]!, frames[index]!]
      }

      expect(frames.every((frame) => frame.bytes.length <= maximumFrameBytes)).toBe(true)
      expect(frames.filter((frame) => frame.isLastFrameOfRecord).length).toBe(1)
      expect(Array.from(assembleRecord(frames))).toEqual(Array.from(record))
    }),
  )
})

it("rejects a frame size that is not a positive integer", () => {
  for (const maximumFrameBytes of [0, -1, 1.5, Number.NaN]) {
    expect(Effect.runSync(Effect.flip(frameRecord(0, new Uint8Array(4), maximumFrameBytes)))._tag).toBe("InvalidFrameSize")
  }
})
