import * as Nav from "@foldkit/ui/nav"
import type { Html, HtmlBuilder } from "foldkit/html"
import { howItWorksRouter, libraryRouter, privacyRouter, quickShareRouter, runYourOwnRouter, securityRouter } from "../app/routes.ts"
import { assetPath } from "../app/assets.ts"
import { icon } from "../ui/icon.ts"

/** Operators of modified versions should point this at their own source. */
export const sourceUrl = "https://github.com/phibkro/file-transfer"

export const siteHeader = <Message>(
  h: HtmlBuilder<Message>,
  currentPath: string | undefined,
  workspaceNavigation?: { quick: Message; library: Message },
): Html =>
  h.header(
    [h.Class("topbar site-header")],
    [
      h.div(
        [h.Class("shell mast")],
        [
          h.a(
            [
              h.Href(workspaceNavigation ? "#quick" : quickShareRouter()),
              h.Class("brand"),
              h.AriaLabel("Pocketdrop home"),
              ...(workspaceNavigation ? [h.OnClick(workspaceNavigation.quick)] : []),
            ],
            [h.span([h.Class("brand-icon")], [icon(h, "package")]), "Pocketdrop", h.span([h.Class("brand-dot")], ["."])],
          ),
          Nav.view<"quick" | "library">({
            items: ["quick", "library"],
            ariaLabel: "Main navigation",
            toHref: (page) => {
              if (workspaceNavigation) {
                return `#${page}`
              }

              return page === "quick" ? quickShareRouter() : libraryRouter()
            },
            isItemCurrent: (page) => workspaceNavigation === undefined && currentPath === (page === "quick" ? quickShareRouter() : libraryRouter()),
            toView: ({ nav, items }) =>
              h.nav(
                nav,
                items.map((item) =>
                  h.keyed("a")(
                    item.value,
                    [
                      ...item.link,
                      ...(workspaceNavigation ? [h.OnClick(workspaceNavigation[item.value])] : []),
                      ...(workspaceNavigation && currentPath === (item.value === "quick" ? quickShareRouter() : libraryRouter())
                        ? [h.Attribute("aria-current", "location")]
                        : []),
                    ],
                    [item.value === "quick" ? "Quick Share" : "Library"],
                  ),
                ),
              ),
          }),
          h.a([h.Href(sourceUrl), h.Class("button source-button"), h.Attribute("aria-label", "Source code")], [icon(h, "github"), h.span([], ["Source"])]),
        ],
      ),
    ],
  )

export const workspaceHero = <Message>(h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("hero"), h.Attribute("aria-labelledby", "workspace-title")],
    [
      h.div(
        [h.Class("hero-copy")],
        [
          h.div([h.Class("eyebrow")], [h.span([h.Class("small-dot")]), "Browser file sharing"]),
          h.h1([h.Attribute("id", "workspace-title")], ["Send a file.", h.br([]), h.em([], ["Keep the good ones."])]),
          h.p([], ["Quickly share files from your browser. Keep the ones you share often in a catalog on this device."]),
        ],
      ),
      h.div(
        [h.Class("hero-art"), h.Attribute("aria-hidden", "true")],
        [h.img([h.Attribute("src", "/pocketdrop-transfer.svg"), h.Attribute("alt", ""), h.Attribute("width", "438"), h.Attribute("height", "228")])],
      ),
    ],
  )

export const siteFooter = <Message>(h: HtmlBuilder<Message>, options?: { support: boolean }): Html =>
  h.footer(
    [h.Class("site-footer shell")],
    [
      ...(options?.support === true
        ? [h.div([h.Class("support")], [h.h2([], ["Thanks for using Pocketdrop!"]), h.p([], ["Free software for sharing files privately."])])]
        : []),
      h.div(
        [h.Class("footer-content")],
        [
          h.div([h.Class("foot-brand")], [icon(h, "package"), "Pocketdrop"]),
          h.p([], ["Files are encrypted in your browser. ", h.a([h.Href(`${sourceUrl}/blob/main/LICENSE`)], ["AGPL-3.0"]), "."]),
          h.nav(
            [h.Attribute("aria-label", "Information")],
            [
              h.a([h.Href(howItWorksRouter())], ["How it works"]),
              h.a([h.Href(securityRouter())], ["Security"]),
              h.a([h.Href(privacyRouter())], ["Privacy"]),
              h.a([h.Href(runYourOwnRouter())], ["Run your own"]),
              h.a([h.Href(assetPath("thirdPartyNotices"))], ["Third-party notices"]),
            ],
          ),
        ],
      ),
    ],
  )
