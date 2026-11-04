import { readFileSync } from "node:fs"
import { describe, expect, it } from "vite-plus/test"
import { layout } from "../scripts/layout.ts"

const transform = async (file: string) => {
  const hook = layout().transformIndexHtml

  if (!hook || !("handler" in hook)) {
    throw new Error("Expected the layout HTML transform hook")
  }

  const filename = new URL(`../${file}`, import.meta.url)

  // SAFETY: this transform uses only its HTML and context arguments, not Vite plugin context.
  return await hook.handler.call({} as ThisParameterType<typeof hook.handler>, readFileSync(filename, "utf-8"), {
    filename: filename.pathname,
    path: `/${file}`,
  })
}

const pages = [
  { file: "how-it-works.html", title: "How it works", text: "What the server sees, and what it never sees", path: "/how-it-works" },
  { file: "security.html", title: "Security", text: "What it does not protect against", path: "/security" },
  { file: "privacy.html", title: "Privacy", text: "Never stored on a server", path: "/privacy" },
  { file: "run-your-own.html", title: "Run your own", text: "Limits you control", path: "/run-your-own" },
] as const

describe("static site", () => {
  it.each(pages)("renders $title without JavaScript and retains the shared policies and footer", async ({ file, title, text, path }) => {
    const html = await transform(file)

    expect(html).toContain(`<h1>${title}</h1>`)
    expect(html).toContain(text)
    expect(html).toContain("Content-Security-Policy")
    expect(html).toContain("no-referrer")
    expect(html).toContain("site-footer")
    expect(html).toContain("AGPL-3.0")
    expect(html).toContain("https://github.com/phibkro/file-transfer")
    expect(html).toContain(`aria-current="page" data-current="" href="${path}"`)
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<!-- layout:")
  })

  it("keeps the transfer diagram and report destination", async () => {
    const how = await transform("how-it-works.html")
    const security = await transform("security.html")

    expect(how).toContain("<svg")
    expect(how).toContain('viewBox="0 0 640 400"')
    expect(how).toContain('aria-labelledby="flow-title flow-description"')
    expect(how).toContain("<marker")
    expect(security).toContain('id="report"')
  })

  it("keeps the shared head but leaves index chrome to the application", async () => {
    const html = await transform("index.html")
    expect(html).toContain("Content-Security-Policy")
    expect(html).toContain("no-referrer")
    expect(html).not.toContain("site-header")
    expect(html).not.toContain("site-footer")
    expect(html).toContain('id="app"')
  })
})
