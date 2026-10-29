/**
 * Aggregate counters only, and only when the operator opts in (docs/decisions/0019). Events carry no identifiers,
 * names, keys or addresses. A transfer's size is reduced to a coarse bucket; relayed volume is counted in whole
 * megabytes, rounded up, and only ever kept as a sum (the relay carries those bytes, so it learns nothing new).
 */
import { declareGuarantees } from "@file-transfer/conformance/guarantee"
import { Context, Effect, Layer, Ref } from "effect"

export type TelemetryEventKind = "room-created" | "recipient-joined" | "transfer-completed" | "transfer-failed" | "path-direct" | "path-relayed"

export type SizeBucket = "under-10-megabytes" | "under-1-gigabyte" | "under-10-gigabytes" | "10-gigabytes-or-more"

export interface TelemetryEvent {
  readonly kind: TelemetryEventKind
  readonly sizeBucket?: SizeBucket
  /** Megabytes the relay carried for the transfer, rounded up; only on the event that ends a transfer. */
  readonly relayedMegabytes?: number
}

export interface TelemetrySnapshot {
  readonly byKind: Readonly<Record<TelemetryEventKind, number>>
  readonly bySizeBucket: Readonly<Record<SizeBucket, number>>
  readonly relayedMegabytes: number
}

/** Bytes as whole megabytes, rounded up, for `relayedMegabytes`. */
export const megabytesFor = (bytes: number): number => Math.ceil(Math.max(0, bytes) / 1_000_000)

export const sizeBucketFor = (bytes: number): SizeBucket => {
  if (bytes < 10 * 1000 ** 2) {
    return "under-10-megabytes"
  }

  if (bytes < 1000 ** 3) {
    return "under-1-gigabyte"
  }

  if (bytes < 10 * 1000 ** 3) {
    return "under-10-gigabytes"
  }

  return "10-gigabytes-or-more"
}

export const eventKinds: readonly TelemetryEventKind[] = [
  "room-created",
  "recipient-joined",
  "transfer-completed",
  "transfer-failed",
  "path-direct",
  "path-relayed",
]

export const sizeBuckets: readonly SizeBucket[] = ["under-10-megabytes", "under-1-gigabyte", "under-10-gigabytes", "10-gigabytes-or-more"]

export class Telemetry extends Context.Service<
  Telemetry,
  {
    readonly record: (event: TelemetryEvent) => Effect.Effect<void>
    readonly snapshot: Effect.Effect<TelemetrySnapshot>
  }
>()("file-transfer/Telemetry") {}

// SAFETY: fromEntries over every member of eventKinds (and of sizeBuckets) yields exactly the keys of each Record.
export const emptySnapshot = (): TelemetrySnapshot => ({
  byKind: Object.fromEntries(eventKinds.map((kind) => [kind, 0])) as Record<TelemetryEventKind, number>,
  bySizeBucket: Object.fromEntries(sizeBuckets.map((bucket) => [bucket, 0])) as Record<SizeBucket, number>,
  relayedMegabytes: 0,
})

/**
 * Counts one event into a snapshot: the rule every layer applies (the reference layer here, the counters Durable
 * Object in each platform). `increment` exists only for the negative control that double counts.
 */
export const applyEvent = (snapshot: TelemetrySnapshot, event: TelemetryEvent, increment = 1): TelemetrySnapshot => ({
  byKind: { ...snapshot.byKind, [event.kind]: snapshot.byKind[event.kind] + increment },
  bySizeBucket:
    event.sizeBucket === undefined ? snapshot.bySizeBucket : { ...snapshot.bySizeBucket, [event.sizeBucket]: snapshot.bySizeBucket[event.sizeBucket] + 1 },
  relayedMegabytes: snapshot.relayedMegabytes + (event.relayedMegabytes ?? 0),
})

export const telemetryGuarantees = declareGuarantees([
  {
    identifier: "telemetry/exact-counts",
    property: "every recorded event is counted exactly once, by kind and by size bucket, and its relayed megabytes are summed",
    strength: "port-enforced",
  },
  {
    identifier: "telemetry/aggregate-only",
    property: "a snapshot holds only counters over the declared kinds and buckets, never anything per event",
    strength: "port-enforced",
  },
])

export type TelemetryGuarantee = (typeof telemetryGuarantees)[number]["identifier"]

/**
 * In-memory reference layer: the executable model every platform must match. `faults` builds the deliberately broken
 * variants that the negative controls need; production code always uses `TelemetryReference`, which has none.
 */
export const makeTelemetryReference = (faults: ReadonlySet<TelemetryGuarantee> = new Set()) =>
  Layer.effect(
    Telemetry,
    Effect.gen(function* () {
      const counters = yield* Ref.make(emptySnapshot())
      const recent = yield* Ref.make<readonly TelemetryEvent[]>([])
      const increment = faults.has("telemetry/exact-counts") ? 2 : 1

      return {
        record: (event) =>
          Effect.andThen(
            Ref.update(recent, (events) => [...events, event]),
            Ref.update(counters, (current) => applyEvent(current, event, increment)),
          ),
        snapshot: faults.has("telemetry/aggregate-only")
          ? Effect.map(Effect.all([Ref.get(counters), Ref.get(recent)]), ([snapshot, events]): TelemetrySnapshot => {
              const leaky = { ...snapshot, recentEvents: events }

              return leaky
            })
          : Ref.get(counters),
      }
    }),
  )

export const TelemetryReference = makeTelemetryReference()
