/**
 * The instance's settings for direct paths between browsers (docs/decisions/0022), answered at `GET /api/direct`:
 * whether endpoints may set one up, and the STUN servers that tell each browser its public address. STUN only: a
 * browser pair that cannot connect directly uses the room's relay, which costs far less per GB than TURN (ADR 0013).
 * Cloudflare documents its STUN service as "free and unlimited" (https://developers.cloudflare.com/realtime/turn/faq/,
 * read 2026-10-29). Pure: no I/O.
 */

/** Unset variables are undefined on Cloudflare and null on workerd (`fromEnvironment`); both mean the default. */
export interface DirectVariables {
  /** `off` keeps every transfer on the relay; anything else, or nothing, allows direct paths. */
  readonly DIRECT_CONNECTIONS?: string | null
  /** STUN server URLs separated by commas or spaces; `none` for none (direct paths then work only on one network). */
  readonly STUN_URLS?: string | null
}

export interface DirectSettings {
  readonly enabled: boolean
  readonly iceServers: readonly { readonly urls: readonly string[] }[]
}

export const defaultStunUrls: readonly string[] = ["stun:stun.cloudflare.com:3478"]

const stunUrl = /^stuns?:[^\s,]{1,253}$/u

const stunUrlsOf = (value: string | null | undefined): readonly string[] => {
  if (value === undefined || value === null) {
    return defaultStunUrls
  }

  return value
    .split(/[\s,]+/u)
    .filter((url) => stunUrl.test(url))
    .slice(0, 8)
}

export const readDirectSettings = (variables: DirectVariables): DirectSettings => {
  const urls = stunUrlsOf(variables.STUN_URLS)

  return {
    enabled: variables.DIRECT_CONNECTIONS?.trim().toLowerCase() !== "off",
    iceServers: urls.length === 0 ? [] : [{ urls }],
  }
}
