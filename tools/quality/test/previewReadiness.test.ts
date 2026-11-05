import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, it } from "vite-plus/test"
import { checkPreview, classifyPreviewResponse } from "../src/previewReadiness.ts"

const preview = new URL("https://version.example.workers.dev")
const access = "https://phibkro.cloudflareaccess.com/cdn-cgi/access/login/version.example.workers.dev?secret=not-logged"

describe("preview readiness", () => {
  it("distinguishes HTML, the expected Access gate, and unexpected responses", () => {
    expect(classifyPreviewResponse(preview, 200, "text/html; charset=utf-8", undefined)).toBe("app")
    expect(classifyPreviewResponse(preview, 302, undefined, access)).toBe("protected")
    for (const location of [
      undefined,
      "/login",
      "https://other.cloudflareaccess.com/cdn-cgi/access/login/version.example.workers.dev",
      "https://phibkro.cloudflareaccess.com/cdn-cgi/access/login/other.example",
      "https://phibkro.cloudflareaccess.com.evil.example/cdn-cgi/access/login/version.example.workers.dev",
    ]) {
      expect(classifyPreviewResponse(preview, 302, undefined, location)).toBe("unexpected-redirect")
    }
    expect(classifyPreviewResponse(preview, 307, undefined, access)).toBe("unexpected-redirect")
    for (const status of [401, 403, 503]) expect(classifyPreviewResponse(preview, status, "text/html", undefined)).toBe("retry")
    expect(classifyPreviewResponse(preview, 200, "application/json", undefined)).toBe("retry")
  })

  it("requests the share route without following redirects and retries failures", async () => {
    let calls = 0
    const fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        calls++
        expect(String(input)).toBe(`${preview.origin}/r/aaaaaaaaaaaaaaaaaaaaaa`)
        expect(init?.redirect).toBe("manual")
        return Promise.resolve(calls === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 302, headers: { location: access } }))
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    const result = await Effect.runPromise(
      checkPreview(preview, { attempts: 2, timeout: 500, delay: 0 }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    )
    expect(result).toBe("protected")
    expect(calls).toBe(2)
  })

  it("times out and rejects a bounded run of network failures", async () => {
    let calls = 0
    const fetch = Object.assign(
      () => {
        calls++
        return Promise.withResolvers<Response>().promise
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    const result = await Effect.runPromise(
      checkPreview(preview, { attempts: 2, timeout: 10, delay: 0 }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    )
    expect(result).toBe("retry")
    expect(calls).toBe(2)
  })
})
