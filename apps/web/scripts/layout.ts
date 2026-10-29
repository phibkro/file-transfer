/**
 * The site's shared layout, applied at build time (and by the dev server) by a Vite plugin: every page's HTML carries
 * markers that become the shared head, header and footer here. Nothing of the layout runs in the browser, so the
 * content pages ship no JavaScript and their navigation works without it.
 *
 *   <!-- layout:head -->    charset, viewport, content security policy, referrer policy, stylesheet
 *   <!-- layout:header -->  site name and navigation, with the current page marked
 *   <!-- layout:footer -->  licence, source code, reporting and self-hosting links
 */
import nodePath from "node:path"
import type { Plugin } from "vite-plus"

/**
 * Where the source code is. AGPL-3.0 section 13 asks anyone who runs a modified version for others to offer them its
 * source: an operator who changes the code points this at their own repository.
 */
export const sourceUrl = "https://github.com/phibkro/file-transfer"

/** One policy for every page of the app: scripts and styles only from this site, nothing inline. */
const contentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"

const pages = [
  { file: "how-it-works.html", path: "/how-it-works", label: "How it works" },
  { file: "security.html", path: "/security", label: "Security" },
  { file: "privacy.html", path: "/privacy", label: "Privacy" },
  { file: "run-your-own.html", path: "/run-your-own", label: "Run your own" },
] as const

const head = `<meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}" />
    <meta name="referrer" content="no-referrer" />
    <link rel="stylesheet" href="/src/style.css" />`

const header = (file: string) => {
  const links = pages.map(({ file: pageFile, path, label }) =>
    pageFile === file ? `<a href="${path}" aria-current="page">${label}</a>` : `<a href="${path}">${label}</a>`,
  )

  return `<header class="site-header">
      <a href="/" class="site-name">File transfer</a>
      <nav aria-label="Site">${[...links, `<a href="${sourceUrl}">Source code</a>`].join("")}</nav>
    </header>`
}

const footer = `<footer class="site-footer">
      <p>
        Free software under the <a href="${sourceUrl}/blob/main/LICENSE">AGPL-3.0</a>. Files are encrypted in your browser;
        servers carry only ciphertext and keep no files. <a href="${sourceUrl}">Read the code</a>,
        <a href="/security#report">report a problem</a>, or <a href="/run-your-own">run your own</a>.
      </p>
    </footer>`

/** Replaces one marker, failing the build when a page lacks it, so no page ships without its layout. */
const replaceMarker = (html: string, marker: string, replacement: string, file: string): string => {
  const token = `<!-- layout:${marker} -->`

  if (!html.includes(token)) {
    throw new Error(`${file} has no ${token}`)
  }

  return html.replace(token, replacement)
}

/** The Vite plugin; `preview.html` (the sandboxed preview frame) has its own head and is left alone. */
export const layout = (): Plugin => ({
  name: "file-transfer-layout",
  transformIndexHtml: {
    order: "pre",
    handler: (html, context) => {
      const file = nodePath.basename(context.filename)

      if (file === "preview.html") {
        return html
      }

      const withHead = replaceMarker(html, "head", head, file)
      const withHeader = replaceMarker(withHead, "header", header(file), file)

      return replaceMarker(withHeader, "footer", footer, file)
    },
  },
})
