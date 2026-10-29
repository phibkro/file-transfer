import { describe, expect, it } from "vite-plus/test"
import { decodeSaltAnswer } from "../src/salt.ts"

describe("decodeSaltAnswer", () => {
  it("accepts 32 bytes of lowercase hex and nothing else", () => {
    const salt = "ab".repeat(32)
    expect(decodeSaltAnswer({ salt })).toBe(salt)
    expect(decodeSaltAnswer({ salt: "AB".repeat(32) })).toBeUndefined()
    expect(decodeSaltAnswer({ salt: "ab".repeat(31) })).toBeUndefined()
    expect(decodeSaltAnswer({ salt: "" })).toBeUndefined()
    expect(decodeSaltAnswer(salt)).toBeUndefined()
  })
})
