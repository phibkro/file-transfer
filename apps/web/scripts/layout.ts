/** Build-time shared site layout. Content pages remain useful without JavaScript. */
import nodePath from "node:path"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { renderToString } from "foldkit/experimental/server"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Plugin } from "vite-plus"
import { contentPages } from "../src/site/content.ts"
import { siteFooter, siteHeader } from "../src/site/layout.ts"
import { appearanceStorageKey, appearanceValues } from "../src/capabilities/appearance/preference.ts"

// Run before styles paint, including static pages, with a CSP hash rather than unsafe-inline.
const appearanceStartup = `try{const value=localStorage.getItem(${JSON.stringify(appearanceStorageKey)});if(${JSON.stringify(appearanceValues.filter((value) => value !== "system"))}.includes(value))document.documentElement.dataset.appearance=value}catch{}`
const appearanceHash = createHash("sha256").update(appearanceStartup).digest("base64")
const contentSecurityPolicy = `default-src 'self'; script-src 'self' 'sha256-${appearanceHash}'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`

const head = `<meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}" />
    <meta name="referrer" content="no-referrer" />
    <script>${appearanceStartup}</script>
    <link rel="icon" href="/mark.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/src/styles/theme.css" />`

const render = (view: (h: HtmlBuilder<never>) => Html): string =>
  Effect.runSync(renderToString<null, never>({ init: () => ({ model: null }), view: (_model, h) => ({ title: "", body: view(h) }) }, { isHydratable: false }))
    .html

const footer = render(siteFooter)

const isContentPage = (file: string): file is keyof typeof contentPages => Object.hasOwn(contentPages, file)

const replaceMarker = (html: string, marker: string, replacement: string, file: string): string => {
  const token = `<!-- layout:${marker} -->`

  if (!html.includes(token)) {
    throw new Error(`${file} has no ${token}`)
  }

  return html.replace(token, replacement)
}

/** The sandboxed preview has its own head and is left alone. */
export const layout = (): Plugin => ({
  name: "file-transfer-layout",
  transformIndexHtml: {
    order: "pre",
    handler: (html, context) => {
      const file = nodePath.basename(context.filename)

      if (file === "preview.html") {
        return html
      }

      let result = replaceMarker(html, "head", head, file)

      if (file === "index.html") {
        return result
      }

      result = replaceMarker(
        result,
        "header",
        render((h) => siteHeader(h, `/${file.replace(/\.html$/u, "")}`)),
        file,
      )

      if (isContentPage(file)) {
        result = replaceMarker(result, "content", render(contentPages[file]), file)
      }

      return replaceMarker(result, "footer", footer, file)
    },
  },
})
