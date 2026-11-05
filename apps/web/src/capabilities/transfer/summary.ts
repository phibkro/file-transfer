// oxlint-effect-plugin ignore-file:
// reason: browser glue over fetch and clipboard Promises for the completion report; moves into libraries/client with the rest of the MVP orchestration (docs/plan.md)
/**
 * The completion summary: size, time, speed, reconnects, the Cloudflare location this browser went through and the
 * browser, with a button that copies them as text for network testing. It never includes file names, the link or
 * keys. The location comes from Cloudflare's `/cdn-cgi/trace` on this same origin; elsewhere it reads "unknown".
 */
import type { TransferSummary } from "./report.ts"
import { formatSize } from "../../ui/view.ts"

/** The `colo` line of Cloudflare's trace endpoint, such as "OSL"; undefined off Cloudflare. */
export const edgeLocation = async (): Promise<string | undefined> => {
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

export const megabytesPerSecond = (summary: TransferSummary): string =>
  summary.seconds > 0 ? `${(summary.bytes / 1e6 / summary.seconds).toFixed(1)} MB/s` : "n/a"

export const pathText = (summary: TransferSummary): string => (summary.direct ? "direct between browsers" : "through the server's relay")

/** The direct path's story: when it opened and how often it dropped, for testing on real networks. */
export const directText = (summary: TransferSummary): string => {
  if (summary.secondsToDirect === undefined) {
    return "never opened"
  }

  const drops = summary.directDrops === 1 ? "dropped once" : `dropped ${summary.directDrops} times`

  return `opened after ${summary.secondsToDirect.toFixed(1)} s, ${summary.directDrops === 0 ? "never dropped" : drops}`
}

interface NetworkInformation {
  readonly type?: string
  readonly effectiveType?: string
  readonly downlink?: number
}

/** What the browser says about its network; only Chromium-based browsers do (the Network Information API). */
const networkText = (): string => {
  if (!("connection" in navigator)) {
    return "not reported by this browser"
  }

  // SAFETY: the `in` check above found the property; the DOM types this project builds with do not declare it.
  const connection = navigator.connection as NetworkInformation | undefined

  const parts = [
    connection?.type,
    connection?.effectiveType === undefined ? undefined : `${connection.effectiveType}-like`,
    connection?.downlink === undefined ? undefined : `about ${connection.downlink} Mbit/s down`,
  ].filter((part) => part !== undefined)

  return parts.length === 0 ? "not reported by this browser" : parts.join(", ")
}

export const reportText = (role: string, summary: TransferSummary, location: string): string =>
  [
    `file-transfer report (${role})`,
    `size: ${formatSize(summary.bytes)} (${summary.bytes} bytes)`,
    `time: ${summary.seconds.toFixed(1)} s`,
    `speed: ${megabytesPerSecond(summary)}`,
    `reconnects: ${summary.reconnects}`,
    `path: ${pathText(summary)}`,
    `direct path: ${directText(summary)}`,
    `network: ${networkText()}`,
    `cloudflare location: ${location}`,
    `browser: ${browserName()}`,
  ].join("\n")
