import { describe, expect, it } from "vite-plus/test"
import { candidatePaths, contentTypeFor, fallsBackToApp, headersFor, isHidden, parseHeaderRules } from "../src/assetRouting.ts"

describe("candidate paths", () => {
  it("map clean URLs to their HTML files, as Cloudflare does", () => {
    expect(candidatePaths("/")).toEqual(["/index.html"])
    expect(candidatePaths("/security")).toEqual(["/security", "/security.html", "/security/index.html"])
    expect(candidatePaths("/assets/main-abc.js")).toEqual(["/assets/main-abc.js"])
    expect(candidatePaths("/docs/")).toEqual(["/docs/index.html"])
  })

  it("fall back to the app outside the hashed assets, and hide configuration", () => {
    expect(fallsBackToApp("/r/abcdefghijklmnopqrstuv")).toBe(true)
    expect(fallsBackToApp("/assets/missing.js")).toBe(false)
    expect(isHidden("/_headers")).toBe(true)
    expect(fallsBackToApp("/_headers")).toBe(false)
  })

  it("give each file its type", () => {
    expect(contentTypeFor("/index.html")).toBe("text/html; charset=utf-8")
    expect(contentTypeFor("/assets/main.JS")).toBe("text/javascript; charset=utf-8")
    expect(contentTypeFor("/blob")).toBe("application/octet-stream")
  })
})

describe("_headers", () => {
  const rules = parseHeaderRules(`# comment
/assets/*
  Access-Control-Allow-Origin: *

/preview*
  Content-Security-Policy: sandbox allow-scripts; default-src 'none'
  X-Content-Type-Options: nosniff

https://:version.:subdomain.workers.dev/*
  X-Robots-Tag: noindex

/admin*
  X-Robots-Tag: noindex
  ! Access-Control-Allow-Origin
`)

  it("applies matching rules and only those", () => {
    expect(Object.fromEntries(headersFor(rules, "/assets/main.js"))).toEqual({ "access-control-allow-origin": "*" })
    expect(headersFor(rules, "/preview.html").get("content-security-policy")).toBe("sandbox allow-scripts; default-src 'none'")
    expect(headersFor(rules, "/preview").get("x-content-type-options")).toBe("nosniff")
    expect(Object.fromEntries(headersFor(rules, "/admin"))).toEqual({ "x-robots-tag": "noindex" })
    expect(headersFor(rules, "/").size).toBe(0)
  })

  it("treats dots and other characters in patterns literally", () => {
    const literal = parseHeaderRules("/a.b\n  X-Test: 1\n")
    expect(headersFor(literal, "/a.b").get("x-test")).toBe("1")
    expect(headersFor(literal, "/axb").size).toBe(0)
  })
})
