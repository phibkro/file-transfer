import { Console, Effect, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"

const expectedAccessOrigin = "https://phibkro.cloudflareaccess.com"

export type PreviewResult = "app" | "protected" | "unexpected-redirect" | "retry"

export const classifyPreviewResponse = (preview: URL, status: number, contentType: string | undefined, location: string | undefined): PreviewResult => {
  if (status === 200 && contentType?.toLowerCase().startsWith("text/html") === true) {
    return "app"
  }

  if (status >= 300 && status < 400) {
    if (status === 302 && location !== undefined) {
      try {
        const target = new URL(location)

        if (target.origin === expectedAccessOrigin && target.pathname === `/cdn-cgi/access/login/${preview.hostname}` && !target.username && !target.password) {
          return "protected"
        }
      } catch {
        // Invalid locations are unexpected redirects.
      }
    }

    return "unexpected-redirect"
  }

  return "retry"
}

export const checkPreview = Effect.fnUntraced(function* (preview: URL, options: { attempts: number; timeout: number; delay: number }) {
  const client = yield* HttpClient.HttpClient
  const url = new URL("/r/aaaaaaaaaaaaaaaaaaaaaa", preview).href

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    const response = yield* client.get(url).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeoutOption(options.timeout),
      Effect.orElseSucceed(() => Option.none()),
    )

    const result = Option.isSome(response)
      ? classifyPreviewResponse(preview, response.value.status, response.value.headers["content-type"], response.value.headers.location)
      : "retry"

    yield* Console.error(`attempt ${attempt}: ${Option.isSome(response) ? `HTTP ${response.value.status}` : "network failure or timeout"}`)

    if (result !== "retry") {
      return result
    }

    if (attempt < options.attempts) {
      yield* Effect.sleep(options.delay)
    }
  }

  return "retry" as const
})
