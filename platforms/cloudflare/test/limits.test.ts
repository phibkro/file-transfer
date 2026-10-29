import { describe, expect, it } from "vite-plus/test"
import { decodeAdmissionRequest, defaultLimits, publicLimits, readLimits, retryAfterMillisecondsOf, withinRelayLimit } from "../src/limits.ts"

describe("readLimits", () => {
  it("uses the defaults when the operator sets nothing", () => {
    expect(readLimits({})).toEqual(defaultLimits)
  })

  it("reads positive integers and a header name", () => {
    expect(readLimits({ LIMIT_ROOMS_PER_ADDRESS_PER_HOUR: "5", LIMIT_RELAYED_BYTES_PER_ROOM: "1000000", CLIENT_ADDRESS_HEADER: " X-Forwarded-For " })).toEqual({
      roomsPerAddressPerHour: 5,
      relayedBytesPerRoom: 1_000_000,
      clientAddressHeader: "x-forwarded-for",
    })
  })

  it.each(["0", "-3", "2.5", "lots", "", "Infinity", "NaN"])("falls back to the default for %j", (value) => {
    const limits = readLimits({ LIMIT_ROOMS_PER_ADDRESS_PER_HOUR: value, LIMIT_RELAYED_BYTES_PER_ROOM: value })
    expect(limits.roomsPerAddressPerHour).toBe(defaultLimits.roomsPerAddressPerHour)
    expect(limits.relayedBytesPerRoom).toBe(defaultLimits.relayedBytesPerRoom)
  })

  it("refuses a header name that is not a plain token", () => {
    expect(readLimits({ CLIENT_ADDRESS_HEADER: "x-test\r\nevil: 1" }).clientAddressHeader).toBe("cf-connecting-ip")
  })

  it("tells clients the limits but not how addresses are read", () => {
    expect(Object.keys(publicLimits(defaultLimits)).toSorted()).toEqual(["relayedBytesPerRoom", "roomsPerAddressPerHour"])
  })
})

describe("withinRelayLimit", () => {
  it("allows a frame that reaches the limit exactly, and refuses one that passes it", () => {
    expect(withinRelayLimit(90, 10, 100)).toBe(true)
    expect(withinRelayLimit(91, 10, 100)).toBe(false)
  })
})

describe("admission bodies", () => {
  it("decodes a policy and refuses anything else", () => {
    expect(decodeAdmissionRequest({ maximumRoomsPerWindow: 3, windowMilliseconds: 3_600_000 })).toEqual({
      maximumRoomsPerWindow: 3,
      windowMilliseconds: 3_600_000,
    })
    expect(decodeAdmissionRequest({ maximumRoomsPerWindow: 0, windowMilliseconds: 1 })).toBeUndefined()
    expect(decodeAdmissionRequest("admit me")).toBeUndefined()
  })

  it("reads the wait from a refusal, with a fallback", () => {
    expect(retryAfterMillisecondsOf({ retryAfterMilliseconds: 1200 }, 99)).toBe(1200)
    expect(retryAfterMillisecondsOf({}, 99)).toBe(99)
  })
})
