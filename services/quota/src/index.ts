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

/**
 * In-memory reference layer with a fixed-window counter per client key. `faults` builds the deliberately broken
 * variants that the negative controls need; production code passes none.
 */
export const makeQuotaReference = (policy: AdmissionPolicy, faults: ReadonlySet<QuotaGuarantee> = new Set()) =>
  Layer.effect(
    Quota,
    Effect.gen(function* () {
      const windows = yield* Ref.make<ReadonlyMap<string, { readonly windowStart: number; readonly count: number }>>(new Map())

      return {
        admitRoomCreation: (clientKey) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const storageKey = faults.has("quota/keys-independent") ? "shared" : clientKey
            const all = yield* Ref.get(windows)
            const current = all.get(storageKey)
            const expired = current !== undefined && now - current.windowStart >= policy.windowMilliseconds && !faults.has("quota/window-resets")
            const window = current === undefined || expired ? { windowStart: now, count: 0 } : current

            if (window.count >= policy.maximumRoomsPerWindow && !faults.has("quota/per-key-limit")) {
              const retryAfterMilliseconds = faults.has("quota/honest-retry-after") ? 0 : window.windowStart + policy.windowMilliseconds - now

              return yield* new RateLimited({ clientKey, retryAfterMilliseconds })
            }

            yield* Ref.set(windows, new Map(all).set(storageKey, { ...window, count: window.count + 1 }))
          }),
      }
    }),
  )
