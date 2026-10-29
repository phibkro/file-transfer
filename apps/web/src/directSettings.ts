// oxlint-effect-plugin ignore-file:
// reason: browser glue over fetch, localStorage and the DOM; no services to compose
/**
 * Whether this browser may use a direct path (docs/decisions/0022), and the STUN servers to find one. Both sides must
 * allow it: the instance (`GET /api/direct`, which also names the STUN servers) and the person, with the setting below,
 * kept in this browser. A direct path shows the other side this device's network address, which the relay hides; so
 * the setting says so, and turning it off keeps every transfer on the relay.
 */
import * as v from "valibot"
import { element } from "./view.ts"

const preferenceKey = "file-transfer:direct-connections"

const DirectSettings = v.object({
  enabled: v.boolean(),
  iceServers: v.pipe(v.array(v.object({ urls: v.pipe(v.array(v.pipe(v.string(), v.regex(/^stuns?:\S+$/u))), v.maxLength(8)) })), v.maxLength(8)),
})

/** Whether the person allows direct connections in this browser (on unless turned off). */
export const directAllowed = (): boolean => {
  try {
    return localStorage.getItem(preferenceKey) !== "off"
  } catch {
    return true
  }
}

const setDirectAllowed = (allowed: boolean) => {
  try {
    if (allowed) {
      localStorage.removeItem(preferenceKey)
    } else {
      localStorage.setItem(preferenceKey, "off")
    }
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

/** The direct path's settings for a connection, or undefined when the person or the instance does not allow it. */
export const directOption = async (): Promise<{ readonly iceServers: readonly RTCIceServer[] } | undefined> => {
  if (!directAllowed() || typeof RTCPeerConnection === "undefined") {
    return undefined
  }

  try {
    const response = await fetch("/api/direct", { cache: "no-store" })
    const decoded = v.safeParse(DirectSettings, response.ok ? await response.json() : undefined)

    return decoded.success && decoded.output.enabled ? { iceServers: decoded.output.iceServers } : undefined
  } catch {
    return undefined
  }
}

/** "Direct connections", on every page: the setting and what it means. */
export const directPanel = (): HTMLElement => {
  const checkbox = element("input", { type: "checkbox", id: "direct-connections" })
  checkbox.checked = directAllowed()
  checkbox.addEventListener("change", () => {
    setDirectAllowed(checkbox.checked)
  })

  return element("details", { class: "direct-panel" }, [
    element("summary", {}, ["Direct connections"]),
    element("p", {}, [checkbox, " ", element("label", { for: "direct-connections" }, ["Connect directly to the other side when possible"])]),
    element("p", { class: "direct-note" }, [
      "Direct is faster and leaves the server less to carry, and the files stay end-to-end encrypted either way. But the other side learns this device's network (IP) address. Turned off, everything goes through the server, which keeps your address from them. Applies to transfers you start or open from now on.",
    ]),
  ])
}
