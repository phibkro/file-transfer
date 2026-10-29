import { describe, expect, it } from "vite-plus/test"
import { isRetryable, unavailable, withOneRetry } from "../src/durableObjectCalls.ts"

const failure = (properties: { readonly retryable?: boolean | string; readonly overloaded?: boolean }) =>
  Object.assign(new Error("Durable Object error"), properties)

describe("isRetryable", () => {
  it("retries what Cloudflare marks retryable", () => {
    expect(isRetryable(failure({ retryable: true }))).toBe(true)
  })

  it("never retries an overloaded object", () => {
    expect(isRetryable(failure({ retryable: true, overloaded: true }))).toBe(false)
  })

  it("does not retry unmarked errors or non-errors", () => {
    expect(isRetryable(new Error("plain"))).toBe(false)
    expect(isRetryable(failure({ retryable: "true" }))).toBe(false)
    expect(isRetryable("retryable")).toBe(false)
    expect(isRetryable(undefined)).toBe(false)
  })
})

describe("withOneRetry", () => {
  it("retries a retryable failure once and returns the second answer", async () => {
    let calls = 0

    const value = await withOneRetry(async () => {
      calls++

      if (calls === 1) {
        throw failure({ retryable: true })
      }

      return "answer"
    })

    expect([value, calls]).toEqual([{ reached: true, value: "answer" }, 2])
  })

  it("does not retry a failure that is not retryable", async () => {
    let calls = 0

    const outcome = await withOneRetry(async () => {
      calls++
      throw failure({ retryable: true, overloaded: true })
    })

    expect([outcome, calls]).toEqual([{ reached: false }, 1])
  })

  it("gives up after the second retryable failure", async () => {
    let calls = 0

    const outcome = await withOneRetry(async () => {
      calls++
      throw failure({ retryable: true })
    })

    expect([outcome, calls]).toEqual([{ reached: false }, 2])
  })
})

describe("unavailable", () => {
  it("answers 503 in JSON with a short retry-after", async () => {
    const response = unavailable()
    expect([response.status, response.headers.get("retry-after"), await response.json()]).toEqual([503, "1", { error: "temporarily unavailable" }])
  })
})
