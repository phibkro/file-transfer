// oxlint-effect-plugin ignore-file:
// reason: DOM glue that adds the site's header and footer to every page
/**
 * The header and footer every page shares: the app (`/`, `/r/<room>`) and the content pages (how it works, security,
 * privacy, running your own). One definition, so the pages cannot drift apart. The content pages carry their text in
 * their HTML and stay readable without script; only this navigation needs it.
 */
import { element } from "./view.ts"

/**
 * Where the source code is. AGPL-3.0 section 13 asks anyone who runs a modified version for others to offer them its
 * source: an operator who changes the code points this at their own repository.
 */
export const sourceUrl = "https://github.com/phibkro/file-transfer"

const pages = [
  { path: "/how-it-works", label: "How it works" },
  { path: "/security", label: "Security" },
  { path: "/privacy", label: "Privacy" },
  { path: "/run-your-own", label: "Run your own" },
] as const

/** Workers static assets serve `/security` for `security.html`; other hosts may use either form. */
const isCurrent = (path: string): boolean => location.pathname === path || location.pathname === `${path}.html`

const link = (path: string, label: string): HTMLAnchorElement => {
  const anchor = element("a", { href: path }, [label])

  if (isCurrent(path)) {
    anchor.setAttribute("aria-current", "page")
  }

  return anchor
}

const siteHeader = (): HTMLElement =>
  element("header", { class: "site-header" }, [
    element("a", { href: "/", class: "site-name" }, ["File transfer"]),
    element("nav", { "aria-label": "Site" }, [...pages.map(({ path, label }) => link(path, label)), element("a", { href: sourceUrl }, ["Source code"])]),
  ])

const siteFooter = (): HTMLElement =>
  element("footer", { class: "site-footer" }, [
    element("p", {}, [
      "Free software under the ",
      element("a", { href: `${sourceUrl}/blob/main/LICENSE` }, ["AGPL-3.0"]),
      ". Files are encrypted in your browser; servers carry only ciphertext and keep no files. ",
      element("a", { href: sourceUrl }, ["Read the code"]),
      ", ",
      element("a", { href: "/security#report" }, ["report a problem"]),
      ", or ",
      element("a", { href: "/run-your-own" }, ["run your own"]),
      ".",
    ]),
  ])

/** Puts the site header before `main` and the footer after `after` (the last thing on the page). */
export const installSiteChrome = (main: HTMLElement, after: HTMLElement = main) => {
  main.before(siteHeader())
  after.after(siteFooter())
}
