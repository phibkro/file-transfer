import { Console, Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { checkPreview } from "./previewReadiness.ts"

const preview = new URL(process.env.PREVIEW_URL ?? "")

const program = Effect.gen(function* () {
  const result = yield* checkPreview(preview, { attempts: 24, timeout: 10_000, delay: 5000 })

  if (result === "protected") {
    yield* Console.error("::warning::Cloudflare Access protects the preview; app readiness and deployed end-to-end behavior were not verified.")
  }

  if (result === "app" || result === "protected") {
    yield* Console.log(result)

    return 0
  }

  yield* Console.error(
    result === "unexpected-redirect" ? "Unexpected preview redirect" : "Preview did not return an application page or the expected Access redirect",
  )

  return 1
}).pipe(Effect.provide(FetchHttpClient.layer))

process.exitCode = await Effect.runPromise(program)
