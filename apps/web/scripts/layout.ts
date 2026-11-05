/** Build-time shared site layout. Content pages remain useful without JavaScript. */
import nodePath from "node:path"
import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { renderToString } from "foldkit/experimental/server"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Plugin } from "vite-plus"
import { routeTree } from "../src/routing/routeTree.gen.ts"
import { siteFooter, siteHeader } from "../src/site/layout.ts"
import { appearanceStorageKey, appearanceValues } from "../src/capabilities/appearance/preference.ts"
import { readRouteInventoryEffect } from "./fileRoutes.ts"

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

const staticPages = (tree: typeof routeTree) =>
  tree.routes.flatMap((entry) =>
    "staticPage" in entry.route.options ? [{ path: entry.path, file: `${entry.path.slice(1)}.html`, view: entry.route.options.staticPage.view }] : [],
  )

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
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const pathname = request.url?.split("?", 1)[0]

      if (pathname === undefined || request.headers.accept?.includes("text/html") !== true) {
        next()

        return
      }

      const handle = async () => {
        try {
          const routes = await Effect.runPromise(readRouteInventoryEffect(server.config.root).pipe(Effect.provide(NodeServices.layer)))
          const normalized = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
          const route = routes.find((candidate) => candidate.staticPage && (normalized === candidate.path || normalized === `${candidate.path}.html`))

          if (route !== undefined) {
            const file = `${route.path.slice(1)}.html`
            let present = false

            try {
              const info = await stat(nodePath.join(server.config.root, file))
              present = info.isFile()
            } catch {
              present = false
            }

            if (!present) {
              response.statusCode = 500
              response.end(`Static route ${route.path} requires template ${file}`)

              return
            }
          }

          next()
        } catch (error) {
          next(error)
        }
      }

      void handle()
    })
  },
  transformIndexHtml: {
    order: "pre",
    handler: async (html, context) => {
      const file = nodePath.basename(context.filename)

      if (file === "preview.html") {
        return html
      }

      let result = replaceMarker(html, "head", head, file)

      if (file === "index.html") {
        return result
      }

      // SAFETY: Vite loads the generated module at this exact path.
      const tree =
        context.server === undefined
          ? routeTree
          : ((await context.server.ssrLoadModule("/src/routing/routeTree.gen.ts")) as { routeTree: typeof routeTree }).routeTree

      const page = staticPages(tree).find((entry) => context.filename.endsWith(`${nodePath.sep}${entry.file.split("/").join(nodePath.sep)}`))
      result = replaceMarker(
        result,
        "header",
        render((h) => siteHeader(h, page?.path ?? `/${file.replace(/\.html$/u, "")}`)),
        file,
      )

      if (page !== undefined) {
        result = replaceMarker(result, "content", render(await Effect.runPromise(page.view())), file)
      }

      return replaceMarker(result, "footer", footer, file)
    },
  },
})
