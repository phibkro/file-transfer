/**
 * Aggregate counters only. Events carry no identifiers, names, keys, sizes in
 * bytes or addresses; sizes are reduced to coarse buckets before recording.
 */
import { declareGuarantees } from "@file-transfer/conformance/guarantee"
import { Context, Effect, Layer, Ref } from "effect"

export type TelemetryEventKind = "room-created" | "recipient-joined" | "transfer-completed" | "transfer-failed" | "path-direct" | "path-relayed"

export type SizeBucket = "under-10-megabytes" | "under-1-gigabyte" | "under-10-gigabytes" | "10-gigabytes-or-more"

export interface TelemetryEvent {
  readonly kind: TelemetryEventKind
  readonly sizeBucket?: SizeBucket
}

export interface TelemetrySnapshot {
  readonly byKind: Readonly<Record<TelemetryEventKind, number>>
  readonly bySizeBucket: Readonly<Record<SizeBucket, number>>
}

export const sizeBucketFor = (bytes: number): SizeBucket => {
  if (bytes < 10 * 1000 ** 2) return "under-10-megabytes"
  if (bytes < 1000 ** 3) return "under-1-gigabyte"
  if (bytes < 10 * 1000 ** 3) return "under-10-gigabytes"
  return "10-gigabytes-or-more"
}

export const eventKinds: ReadonlyArray<TelemetryEventKind> = [
  "room-created",
  "recipient-joined",
  "transfer-completed",
  "transfer-failed",
  "path-direct",
  "path-relayed",
]

export const sizeBuckets: ReadonlyArray<SizeBucket> = ["under-10-megabytes", "under-1-gigabyte", "under-10-gigabytes", "10-gigabytes-or-more"]

export class Telemetry extends Context.Service<
  Telemetry,
  {
    readonly record: (event: TelemetryEvent) => Effect.Effect<void>
    readonly snapshot: Effect.Effect<TelemetrySnapshot>
  }
>()("file-transfer/Telemetry") {}

const emptySnapshot = (): TelemetrySnapshot => ({
  byKind: Object.fromEntries(eventKinds.map((kind) => [kind, 0])) as Record<TelemetryEventKind, number>,
  bySizeBucket: Object.fromEntries(sizeBuckets.map((bucket) => [bucket, 0])) as Record<SizeBucket, number>,
})

export const telemetryGuarantees = declareGuarantees([
  { identifier: "telemetry/exact-counts", property: "every recorded event is counted exactly once, by kind and by size bucket", strength: "port-enforced" },
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
      const recent = yield* Ref.make<ReadonlyArray<TelemetryEvent>>([])
      const increment = faults.has("telemetry/exact-counts") ? 2 : 1
      return {
        record: (event) =>
          Effect.andThen(
            Ref.update(recent, (events) => [...events, event]),
            Ref.update(counters, (current) => ({
              byKind: { ...current.byKind, [event.kind]: current.byKind[event.kind] + increment },
              bySizeBucket:
                event.sizeBucket === undefined
                  ? current.bySizeBucket
                  : { ...current.bySizeBucket, [event.sizeBucket]: current.bySizeBucket[event.sizeBucket] + 1 },
            })),
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
