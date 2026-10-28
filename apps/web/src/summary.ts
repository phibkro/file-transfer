// oxlint-effect-plugin ignore-file:
// reason: browser glue over fetch and clipboard Promises for the completion report; moves into libraries/client with the rest of the MVP orchestration (docs/plan.md)
/**
 * The completion summary: size, time, speed, reconnects, the Cloudflare location this browser went through and the
 * browser, with a button that copies them as text for network testing. It never includes file names, the link or
 * keys. The location comes from Cloudflare's `/cdn-cgi/trace` on this same origin; elsewhere it reads "unknown".
 */
import { currentStatus, onReport, transferSummary } from "./report.ts"
import type { TransferSummary } from "./report.ts"
import { element, formatSize } from "./view.ts"

/** The `colo` line of Cloudflare's trace endpoint, such as "OSL"; undefined off Cloudflare. */
const edgeLocation = async (): Promise<string | undefined> => {
  try {
    const response = await fetch("/cdn-cgi/trace", { cache: "no-store" })

    if (!response.ok) {
      return undefined
    }

    const colo = /^colo=(?<code>[A-Z]{3})$/mu.exec(await response.text())?.groups?.code

    return colo
  } catch {
    return undefined
  }
}

/** Browser family and version from the user agent, without the rest of the string. */
const browserName = (): string => {
  const agent = navigator.userAgent
  const match = /(?<name>Firefox|Edg|OPR|Chrome|Version)\/(?<version>\d+)/u.exec(agent)
  const name = match?.groups?.name
  const version = match?.groups?.version ?? "?"

  if (name === undefined) {
    return "unknown"
  }

  const names = new Map([
    ["Edg", "Edge"],
    ["OPR", "Opera"],
    ["Version", "Safari"],
  ])

  return `${names.get(name) ?? name} ${version}${/Android|iPhone|iPad/u.test(agent) ? " (mobile)" : ""}`
}

const megabytesPerSecond = (summary: TransferSummary): string => (summary.seconds > 0 ? `${(summary.bytes / 1e6 / summary.seconds).toFixed(1)} MB/s` : "n/a")

const reportText = (role: string, summary: TransferSummary, location: string): string =>
  [
    `file-transfer report (${role})`,
    `size: ${formatSize(summary.bytes)} (${summary.bytes} bytes)`,
    `time: ${summary.seconds.toFixed(1)} s`,
    `speed: ${megabytesPerSecond(summary)}`,
    `reconnects: ${summary.reconnects}`,
    `cloudflare location: ${location}`,
    `browser: ${browserName()}`,
  ].join("\n")

const render = async (root: HTMLElement, role: string) => {
  const summary = transferSummary()
  const location = (await edgeLocation()) ?? "unknown"
  const text = reportText(role, summary, location)
  const copy = element("button", { type: "button" }, ["Copy report"])

  const copyReport = async () => {
    // Undefined outside secure contexts, although the DOM types say otherwise; the report stays visible on the page.
    const clipboard: Clipboard | undefined = navigator.clipboard

    if (clipboard === undefined) {
      return
    }

    await clipboard.writeText(text)
    copy.textContent = "Copied"
  }

  copy.addEventListener("click", () => {
    void copyReport()
  })

  const rows: readonly (readonly [string, string])[] = [
    ["Size", formatSize(summary.bytes)],
    ["Time", `${summary.seconds.toFixed(1)} s`],
    ["Speed", megabytesPerSecond(summary)],
    ["Reconnects", String(summary.reconnects)],
    ["Cloudflare location", location],
  ]

  root.append(
    element("section", { class: "summary", "aria-label": "Transfer summary" }, [
      element(
        "dl",
        {},
        rows.flatMap(([term, value]) => [element("dt", {}, [term]), element("dd", {}, [value])]),
      ),
      copy,
    ]),
  )
}

/** Shows the summary once, when this page's transfer completes. */
export const showSummaryOnCompletion = (root: HTMLElement, role: "sender" | "recipient") => {
  let shown = false
  onReport(() => {
    if (shown || currentStatus() !== "complete") {
      return
    }

    shown = true
    void render(root, role)
  })
}
