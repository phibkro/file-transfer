/**
 * Plan entitlements, admission limits, and the speed tiers (docs/decisions/0006).
 * Direct transfers are never limited here: only resources we carry are priced.
 */
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
    case "free":
      return { startsRelayed: false, relayedBytesPerSecondCap: undefined, relayPriority: 0, placesRelayBetweenPeers: false, euJurisdictionAvailable: false }
    case "paid":
      return { startsRelayed: true, relayedBytesPerSecondCap: undefined, relayPriority: 1, placesRelayBetweenPeers: true, euJurisdictionAvailable: false }
    case "team":
      return { startsRelayed: true, relayedBytesPerSecondCap: undefined, relayPriority: 2, placesRelayBetweenPeers: true, euJurisdictionAvailable: true }
  }
}

export class RateLimited extends Data.TaggedError("RateLimited")<{ readonly clientKey: string; readonly retryAfterMilliseconds: number }> {}

export interface AdmissionPolicy {
  readonly maximumRoomsPerWindow: number
  readonly windowMilliseconds: number
}

export class Quota extends Context.Service<
  Quota,
  {
    /** Admits a room creation for an opaque client key (for example a salted hash of the address). */
    readonly admitRoomCreation: (clientKey: string) => Effect.Effect<void, RateLimited>
  }
>()("file-transfer/Quota") {}

/** In-memory reference layer with a fixed-window counter per client key. */
export const quotaReference = (policy: AdmissionPolicy) =>
  Layer.effect(
    Quota,
    Effect.gen(function* () {
      const windows = yield* Ref.make<ReadonlyMap<string, { readonly windowStart: number; readonly count: number }>>(new Map())
      return {
        admitRoomCreation: (clientKey) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const all = yield* Ref.get(windows)
            const current = all.get(clientKey)
            const fresh = current === undefined || now - current.windowStart >= policy.windowMilliseconds
            const window = fresh ? { windowStart: now, count: 0 } : current
            if (window.count >= policy.maximumRoomsPerWindow) {
              return yield* Effect.fail(new RateLimited({ clientKey, retryAfterMilliseconds: window.windowStart + policy.windowMilliseconds - now }))
            }
            yield* Ref.set(windows, new Map(all).set(clientKey, { ...window, count: window.count + 1 }))
          }),
      }
    }),
  )
