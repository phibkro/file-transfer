/**
 * How the self-hosted platform serves apps/web's built files, matching what Cloudflare's static assets do for this
 * site (platforms/cloudflare/wrangler.jsonc): `/security` serves `security.html`, unknown paths outside `/assets/`
 * fall back to `index.html` (the single-page fallback that `/r/<room>` relies on), and the rules in `_headers` apply
 * (https://developers.cloudflare.com/workers/static-assets/headers/). Pure: the assets Worker (assetsWorker.ts) does
 * the I/O.
 */

/** The files to try for a request path, in order; the first that exists is served. */
export const candidatePaths = (pathname: string): readonly string[] => {
  if (pathname.endsWith("/")) {
    return [`${pathname}index.html`]
  }

  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1)

  return lastSegment.includes(".") ? [pathname] : [pathname, `${pathname}.html`, `${pathname}/index.html`]
}

/** Configuration files Cloudflare reads but never serves. */
export const isHidden = (pathname: string): boolean => pathname === "/_headers" || pathname === "/_redirects"

/** Paths that 404 rather than fall back to the app: hashed build output, where a fallback would hide a broken build. */
export const fallsBackToApp = (pathname: string): boolean => !pathname.startsWith("/assets/") && !isHidden(pathname)

const contentTypes: ReadonlyMap<string, string> = new Map([
  ["html", "text/html; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["json", "application/json"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["ico", "image/x-icon"],
  ["txt", "text/plain; charset=utf-8"],
  ["map", "application/json"],
  ["woff2", "font/woff2"],
])

export const contentTypeFor = (path: string): string => contentTypes.get(path.slice(path.lastIndexOf(".") + 1).toLowerCase()) ?? "application/octet-stream"

export interface HeaderRule {
  readonly pattern: RegExp
  readonly set: readonly (readonly [string, string])[]
  readonly remove: readonly string[]
}

/** A `_headers` URL pattern as a regular expression: `*` matches anything, everything else literally. */
const patternOf = (url: string): RegExp =>
  new RegExp(
    `^${url
      .split("*")
      .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".*")}$`,
    "u",
  )

/** Parses `_headers`: a path pattern, then indented `Name: value` lines (or `! Name` to remove), blocks apart. */
export const parseHeaderRules = (text: string): readonly HeaderRule[] => {
  const rules: { pattern: RegExp; set: [string, string][]; remove: string[] }[] = []

  for (const line of text.split("\n")) {
    const trimmed = line.trim()

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue
    }

    const current = rules.at(-1)

    if (!/^\s/u.test(line)) {
      // Host-qualified patterns (https://host/path) apply to Cloudflare hostnames only.
      if (trimmed.startsWith("/")) {
        rules.push({ pattern: patternOf(trimmed), set: [], remove: [] })
      } else {
        rules.push({ pattern: /(?!)/u, set: [], remove: [] })
      }
    } else if (current !== undefined && trimmed.startsWith("! ")) {
      current.remove.push(trimmed.slice(2).trim().toLowerCase())
    } else if (current !== undefined && trimmed.includes(":")) {
      const colon = trimmed.indexOf(":")
      current.set.push([trimmed.slice(0, colon).trim().toLowerCase(), trimmed.slice(colon + 1).trim()])
    }
  }

  return rules
}

/** The headers the rules give a path: values of the same header from several rules are joined with a comma. */
export const headersFor = (rules: readonly HeaderRule[], pathname: string): ReadonlyMap<string, string> => {
  const headers = new Map<string, string>()

  for (const rule of rules) {
    if (!rule.pattern.test(pathname)) {
      continue
    }

    for (const [name, value] of rule.set) {
      const existing = headers.get(name)
      headers.set(name, existing === undefined ? value : `${existing}, ${value}`)
    }

    for (const name of rule.remove) {
      headers.delete(name)
    }
  }

  return headers
}
