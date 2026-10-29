/**
 * The self-hosted platform's static file server: a small Worker in front of workerd's disk service that serves
 * apps/web's build the way Cloudflare's static assets serve it (assetRouting.ts). The room Worker (built from
 * platforms/cloudflare, unchanged) reaches it as its `ASSETS` binding, exactly as on Cloudflare.
 */
import { candidatePaths, contentTypeFor, fallsBackToApp, headersFor, isHidden, parseHeaderRules } from "./assetRouting.ts"
import type { HeaderRule } from "./assetRouting.ts"

interface Files {
  readonly fetch: (input: Request | string, init?: RequestInit) => Promise<Response>
}

interface Environment {
  /** workerd's disk service over the built files (workerd.capnp). */
  readonly FILES: Files
}

let rules: Promise<readonly HeaderRule[]> | undefined

/** `_headers` from the build, read once per process. */
const headerRules = async (files: Files): Promise<readonly HeaderRule[]> => {
  rules ??= files.fetch("http://files/_headers").then(async (response) => (response.ok ? parseHeaderRules(await response.text()) : []))

  return await rules
}

const read = async (files: Files, path: string): Promise<Response | undefined> => {
  const response = await files.fetch(`http://files${path}`)

  return response.ok ? response : undefined
}

/** Fingerprinted build output never changes under one name; everything else is revalidated. */
const cacheControlFor = (path: string): string => (path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate")

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } })
    }

    const { pathname } = new URL(request.url)
    let served: { readonly path: string; readonly response: Response } | undefined

    if (!isHidden(pathname) && !pathname.includes("..")) {
      for (const path of candidatePaths(pathname)) {
        const response = await read(environment.FILES, path)

        if (response !== undefined) {
          served = { path, response }
          break
        }
      }
    }

    if (served === undefined && fallsBackToApp(pathname)) {
      const app = await read(environment.FILES, "/index.html")
      served = app === undefined ? undefined : { path: "/index.html", response: app }
    }

    if (served === undefined) {
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
    }

    const headers = new Headers({ "content-type": contentTypeFor(served.path), "cache-control": cacheControlFor(served.path) })

    // Rules match the requested path, as on Cloudflare, so `/preview` gets the preview page's sandbox.
    for (const [name, value] of headersFor(await headerRules(environment.FILES), pathname)) {
      headers.set(name, value)
    }

    return new Response(request.method === "HEAD" ? null : served.response.body, { status: 200, headers })
  },
}
