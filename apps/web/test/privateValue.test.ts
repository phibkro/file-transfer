import { Redacted, Schema } from "effect"
import { assert, property, string } from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import { privateValue } from "../src/ui/privateValue.ts"

const PrivatePayload = privateValue<{ readonly name: string; readonly secret: string }>()
const jsonCodec = Schema.toCodecJson(PrivatePayload)
const encode = Schema.encodeUnknownSync(jsonCodec)

describe("private browser state", () => {
  it("does not let sensitive contents influence the development JSON projection", () => {
    const publicProjection = encode(Redacted.make({ name: "", secret: "" }))
    assert(
      property(string(), string(), (name, secret) => {
        expect(encode(Redacted.make({ name, secret }))).toEqual(publicProjection)
      }),
      { seed: 741, numRuns: 32 },
    )
  })

  it("rejects restoration of private browser capabilities from serialized state", () => {
    const serialized = encode(Redacted.make({ name: "private-file.txt", secret: "private-key" }))
    const restored = Schema.decodeResult(jsonCodec)(serialized)
    expect(restored._tag).toBe("Failure")
  })
})
