import { appendFile } from "node:fs/promises"

const preview = new URL(process.env.PREVIEW_URL)
const expectedAccessOrigin = "https://phibkro.cloudflareaccess.com"
const probe = new URL("/r/aaaaaaaaaaaaaaaaaaaaaa", preview)

for (let attempt = 1; attempt <= 24; attempt++) {
  let response
  try {
    response = await fetch(probe, { redirect: "manual", signal: AbortSignal.timeout(10000) })
  } catch {
    console.log(`attempt ${attempt}: network failure`)
  }
  if (response) {
    console.log(`attempt ${attempt}: HTTP ${response.status}`)
    let result
    if (response.status === 200 && response.headers.get("content-type")?.toLowerCase().startsWith("text/html")) {
      result = "app"
    } else if (response.status === 302) {
      try {
        const location = new URL(response.headers.get("location"))
        if (
          location.origin === expectedAccessOrigin &&
          location.pathname === `/cdn-cgi/access/login/${preview.hostname}` &&
          !location.username && !location.password
        ) result = "protected"
      } catch {
        // A missing or invalid Location is an unexpected redirect.
      }
      if (!result) throw new Error("Unexpected preview redirect")
    } else if (response.status >= 300 && response.status < 400) {
      throw new Error("Unexpected preview redirect")
    }
    await response.body?.cancel()
    if (result) {
      if (result === "protected") {
        console.log("::warning::Cloudflare Access protects the preview; app readiness and deployed end-to-end behavior were not verified.")
      }
      await appendFile(process.env.GITHUB_OUTPUT, `result=${result}\n`)
      process.exit(0)
    }
  }
  if (attempt < 24) await new Promise((resolve) => setTimeout(resolve, 5000))
}
throw new Error("Preview did not return an application page or the expected Access redirect")
