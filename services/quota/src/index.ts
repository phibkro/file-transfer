/**
 * Plan entitlements, admission limits, and the speed tiers (docs/decisions/0006).
 * Direct transfers are never limited here: only resources we carry are priced.
 */
import { declareGuarantees } from "@file-transfer/conformance/guarantee"
import { Clock, Context, Data, Effect, Layer, Ref } from "effect"

export type Plan = "free" | "paid" | "team"

export interface Entitlements {
  /** Paid plans start on the relay at once and upgrade to direct (relay-first). */
  readonly startsRelayed: boolean
  /** Bytes per second per relayed transfer; `undefined` means uncapped. The free cap is set after M0. */
  readonly relayedBytesPerSecondCap: number | undefined
  /** Higher numbers are served first when relays shed load. */
  readonly relayPriority: number
  readonly placesRelayBetweenPeers: boolean
  readonly euJurisdictionAvailable: boolean
}

export const entitlementsFor = (plan: Plan): Entitlements => {
  switch (plan) {
    case "free": {
      return { startsRelayed: false, relayedBytesPerSecondCap: undefined, relayPriority: 0, placesRelayBetweenPeers: false, euJurisdictionAvailable: false }
    }

    case "paid": {
      return { startsRelayed: true, relayedBytesPerSecondCap: undefined, relayPriority: 1, placesRelayBetweenPeers: true, euJurisdictionAvailable: false }
    }

    case "team": {
      return { startsRelayed: true, relayedBytesPerSecondCap: undefined, relayPriority: 2, placesRelayBetweenPeers: true, euJurisdictionAvailable: true }
    }
  }
}

export class RateLimited extends Data.TaggedError("RateLimited")<{ readonly clientKey: string; readonly retryAfterMilliseconds: number }> {}

export interface AdmissionPolicy {
  readonly maximumRoomsPerWindow: number
  readonly windowMilliseconds: number
}

export const quotaGuarantees = declareGuarantees([
  { identifier: "quota/per-key-limit", property: "within one window a client key is admitted exactly up to the policy's maximum", strength: "port-enforced" },
  { identifier: "quota/keys-independent", property: "one client key's admissions never count against another's", strength: "port-enforced" },
  { identifier: "quota/window-resets", property: "each new window admits a key up to the maximum again", strength: "port-enforced" },
  { identifier: "quota/honest-retry-after", property: "a rejection says exactly how long until the key is admitted again", strength: "port-enforced" },
])

export type QuotaGuarantee = (typeof quotaGuarantees)[number]["identifier"]

export class Quota extends Context.Service<
  Quota,
  {
    /** Admits a room creation for an opaque client key (for example a salted hash of the address). */
    readonly admitRoomCreation: (clientKey: string) => Effect.Effect<void, RateLimited>
  }
>()("file-transfer/Quota") {}

/** One client key's fixed window: when it started and how many admissions it has granted. */
export interface AdmissionWindow {
  readonly windowStart: number
  readonly count: number
}

export type AdmissionDecision =
  | { readonly admitted: true; readonly window: AdmissionWindow }
  | { readonly admitted: false; readonly retryAfterMilliseconds: number }

/**
 * The fixed-window rule every layer applies (the reference layer here, the Durable Object in each platform): a window
 * starts at the first admission after the previous one ended, and admits up to the policy's maximum.
 */
export const admitInWindow = (current: AdmissionWindow | undefined, now: number, policy: AdmissionPolicy): AdmissionDecision => {
  const expired = current !== undefined && now - current.windowStart >= policy.windowMilliseconds
  const window = current === undefined || expired ? { windowStart: now, count: 0 } : current

  if (window.count >= policy.maximumRoomsPerWindow) {
    return { admitted: false, retryAfterMilliseconds: window.windowStart + policy.windowMilliseconds - now }
  }

  return { admitted: true, window: { ...window, count: window.count + 1 } }
}

/**
 * In-memory reference layer over `admitInWindow`. `faults` builds the deliberately broken variants that the negative
 * controls need; production code passes none.
 */
export const makeQuotaReference = (policy: AdmissionPolicy, faults: ReadonlySet<QuotaGuarantee> = new Set()) =>
  Layer.effect(
    Quota,
    Effect.gen(function* () {
      const windows = yield* Ref.make<ReadonlyMap<string, AdmissionWindow>>(new Map())

      const effectivePolicy: AdmissionPolicy = {
        maximumRoomsPerWindow: faults.has("quota/per-key-limit") ? Number.POSITIVE_INFINITY : policy.maximumRoomsPerWindow,
        windowMilliseconds: faults.has("quota/window-resets") ? Number.POSITIVE_INFINITY : policy.windowMilliseconds,
      }

      return {
        admitRoomCreation: (clientKey) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const storageKey = faults.has("quota/keys-independent") ? "shared" : clientKey
            const all = yield* Ref.get(windows)
            const decision = admitInWindow(all.get(storageKey), now, effectivePolicy)

            if (!decision.admitted) {
              const retryAfterMilliseconds = faults.has("quota/honest-retry-after") ? 0 : decision.retryAfterMilliseconds

              return yield* new RateLimited({ clientKey, retryAfterMilliseconds })
            }

            yield* Ref.set(windows, new Map(all).set(storageKey, decision.window))
          }),
      }
    }),
  )
