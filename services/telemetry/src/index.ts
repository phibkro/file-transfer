/**
 * Aggregate counters only. Events carry no identifiers, names, keys, sizes in
 * bytes or addresses; sizes are reduced to coarse buckets before recording.
 */
import { Context, Effect, Layer, Ref } from "effect"

export type TelemetryEventKind =
  | "room-created"
  | "recipient-joined"
  | "transfer-completed"
  | "transfer-failed"
  | "path-direct"
  | "path-relayed"

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

/** In-memory reference layer: the executable model every platform must match. */
export const TelemetryReference = Layer.effect(
  Telemetry,
  Effect.gen(function* () {
    const counters = yield* Ref.make(emptySnapshot())
    return {
      record: (event) =>
        Ref.update(counters, (current) => ({
          byKind: { ...current.byKind, [event.kind]: current.byKind[event.kind] + 1 },
          bySizeBucket:
            event.sizeBucket === undefined
              ? current.bySizeBucket
              : { ...current.bySizeBucket, [event.sizeBucket]: current.bySizeBucket[event.sizeBucket] + 1 },
        })),
      snapshot: Ref.get(counters),
    }
  }),
)
