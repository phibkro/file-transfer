import { describe, expect, it } from "vite-plus/test"
import { defaultStunUrls, readDirectSettings } from "../src/directSettings.ts"

describe("readDirectSettings", () => {
  it("allows direct paths with Cloudflare's STUN server by default", () => {
    expect(readDirectSettings({})).toEqual({ enabled: true, iceServers: [{ urls: defaultStunUrls }] })
  })

  it("reads an unset workerd variable (null) as the default", () => {
    expect(readDirectSettings({ DIRECT_CONNECTIONS: null, STUN_URLS: null })).toEqual(readDirectSettings({}))
  })

  it("turns direct paths off only for off", () => {
    expect(readDirectSettings({ DIRECT_CONNECTIONS: " OFF " }).enabled).toBe(false)
    expect(readDirectSettings({ DIRECT_CONNECTIONS: "on" }).enabled).toBe(true)
  })

  it("reads STUN URLs and drops anything that is not one", () => {
    expect(readDirectSettings({ STUN_URLS: "stun:a.example:3478, stuns:b.example:5349 turn:c.example http://x" }).iceServers).toEqual([
      { urls: ["stun:a.example:3478", "stuns:b.example:5349"] },
    ])
    expect(readDirectSettings({ STUN_URLS: "none" }).iceServers).toEqual([])
  })
})
