// oxlint-effect-plugin ignore-file:
// reason: browser glue over fetch, localStorage and the DOM; no services to compose
/**
 * Whether this browser may use a direct path (docs/decisions/0022), and the STUN servers to find one. Both sides must
 * allow it: the instance (`GET /api/direct`, which also names the STUN servers) and the person, with the setting below,
 * kept in this browser. A direct path shows the other side this device's network address, which the relay hides; so
 * the setting says so, and turning it off keeps every transfer on the relay.
 */
import * as v from "valibot"
import { appearanceStorageKey, isAppearance } from "./appearance.ts"
import type { Appearance } from "./appearance.ts"

const preferenceKey = "file-transfer:direct-connections"

export const storedAppearance = (): Appearance => {
  try {
    const value = localStorage.getItem(appearanceStorageKey)

    return isAppearance(value) ? value : "system"
  } catch {
    return "system"
  }
}

export const setAppearance = (appearance: Appearance): void => {
  document.documentElement.dataset.appearance = appearance

  try {
    if (appearance === "system") {
      localStorage.removeItem(appearanceStorageKey)
    } else {
      localStorage.setItem(appearanceStorageKey, appearance)
    }
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

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

export const setDirectAllowed = (allowed: boolean) => {
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
