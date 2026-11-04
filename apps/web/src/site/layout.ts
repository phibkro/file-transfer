import * as Nav from "@foldkit/ui/nav"
import type { Html, HtmlBuilder } from "foldkit/html"

/** Operators of modified versions should point this at their own source. */
export const sourceUrl = "https://github.com/phibkro/file-transfer"

const pages = {
  "/": "Quick Share",
  "/library": "Library",
  "/how-it-works": "How it works",
  "/security": "Security",
  "/privacy": "Privacy",
  "/run-your-own": "Run your own",
} as const

// SAFETY: pages is a closed object literal with only its declared own string keys.
const paths = Object.keys(pages) as (keyof typeof pages)[]

export const siteHeader = <Message>(h: HtmlBuilder<Message>, currentPath: string): Html =>
  h.header(
    [h.Class("site-header")],
    [
      h.a([h.Href("/"), h.Class("site-name")], ["File transfer"]),
      Nav.view({
        items: paths,
        ariaLabel: "Site",
        toHref: (path) => path,
        isItemCurrent: (path) => path === currentPath,
        toView: ({ nav, items }) => h.nav(nav, [...items.map((item) => h.a(item.link, [pages[item.value]])), h.a([h.Href(sourceUrl)], ["Source code"])]),
      }),
    ],
  )

export const siteFooter = <Message>(h: HtmlBuilder<Message>): Html =>
  h.footer(
    [h.Class("site-footer")],
    [
      h.p(
        [],
        [
          "Free software under the ",
          h.a([h.Href(`${sourceUrl}/blob/main/LICENSE`)], ["AGPL-3.0"]),
          ". Files are encrypted in your browser; servers carry only ciphertext and keep no files. ",
          h.a([h.Href(sourceUrl)], ["Read the code"]),
          ", ",
          h.a([h.Href("/security#report")], ["report a problem"]),
          ", or ",
          h.a([h.Href("/run-your-own")], ["run your own"]),
          ".",
        ],
      ),
    ],
  )
