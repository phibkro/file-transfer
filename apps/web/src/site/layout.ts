import * as Nav from "@foldkit/ui/nav"
import type { Html, HtmlBuilder } from "foldkit/html"
import { howItWorksRouter, libraryRouter, privacyRouter, quickShareRouter, runYourOwnRouter, securityRouter } from "../routes.ts"

/** Operators of modified versions should point this at their own source. */
export const sourceUrl = "https://github.com/phibkro/file-transfer"

const pages = {
  QuickShare: { path: quickShareRouter(), label: "Quick Share" },
  Library: { path: libraryRouter(), label: "Library" },
  HowItWorks: { path: howItWorksRouter(), label: "How it works" },
  Security: { path: securityRouter(), label: "Security" },
  Privacy: { path: privacyRouter(), label: "Privacy" },
  RunYourOwn: { path: runYourOwnRouter(), label: "Run your own" },
} as const

type Page = keyof typeof pages

// SAFETY: pages is a closed local object with only its declared own string keys.
const destinations = Object.keys(pages) as Page[]

export const siteHeader = <Message>(h: HtmlBuilder<Message>, currentPath: string | undefined): Html =>
  h.header(
    [h.Class("site-header")],
    [
      h.a([h.Href(quickShareRouter()), h.Class("site-name")], ["File transfer"]),
      Nav.view<Page>({
        items: destinations,
        ariaLabel: "Site",
        toHref: (page) => pages[page].path,
        isItemCurrent: (page) => pages[page].path === currentPath,
        toView: ({ nav, items }) =>
          h.nav(nav, [...items.map((item) => h.keyed("a")(item.value, item.link, [pages[item.value].label])), h.a([h.Href(sourceUrl)], ["Source code"])]),
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
          h.a([h.Href(`${securityRouter()}#report`)], ["report a problem"]),
          ", or ",
          h.a([h.Href(runYourOwnRouter())], ["run your own"]),
          ".",
        ],
      ),
    ],
  )
