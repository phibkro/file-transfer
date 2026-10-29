/**
 * The operator's opt-in counters (docs/decisions/0019-open-source-first.md): settings, hour keys, the decoding of
 * recorded events, and the OpenMetrics rendering for `GET /api/admin/metrics`. Pure: no I/O, no clock; the Durable
 * Object (countersObject.ts) and the Worker pass in the time and carry out the storage. Counting itself is
 * `applyEvent` from services/telemetry, so this platform counts exactly as the reference layer does.
 */
import { eventKinds, sizeBuckets } from "@file-transfer/service-telemetry"
import type { TelemetryEvent, TelemetryEventKind, TelemetrySnapshot } from "@file-transfer/service-telemetry"
import { Result, Schema } from "effect"

/** The variables an operator sets for counters; all strings, as Workers environment variables are. */
export interface CounterVariables {
  /** `on` to count; anything else, or nothing, leaves counting off. */
  readonly COUNTERS?: string
  /** Days of hourly counts to keep; the totals are kept as long as counting is on. */
  readonly COUNTERS_RETENTION_DAYS?: string
}

export const countersEnabled = (variables: CounterVariables): boolean => variables.COUNTERS?.trim().toLowerCase() === "on"

export const defaultRetentionDays = 90

const RetentionDays = Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 3660 }))
const decodeRetentionDays = Schema.decodeUnknownResult(RetentionDays)

export const retentionDays = (variables: CounterVariables): number => {
  if (variables.COUNTERS_RETENTION_DAYS === undefined) {
    return defaultRetentionDays
  }

  const decoded = decodeRetentionDays(variables.COUNTERS_RETENTION_DAYS)

  return Result.isSuccess(decoded) ? decoded.success : defaultRetentionDays
}

export const hourMilliseconds = 60 * 60 * 1000

/** Hours since the Unix epoch: the key of one hourly bucket. */
export const hourOf = (epochMilliseconds: number): number => Math.floor(epochMilliseconds / hourMilliseconds)

export const hourKeyPrefix = "hour:"

/** The storage key of an hour, zero-padded so keys sort by time. */
export const hourKey = (hour: number): string => `${hourKeyPrefix}${String(hour).padStart(10, "0")}`

/** The hour a storage key names, or undefined for any other key. */
export const hourOfKey = (key: string): number | undefined => {
  if (!key.startsWith(hourKeyPrefix)) {
    return undefined
  }

  const hour = Number(key.slice(hourKeyPrefix.length))

  return Number.isSafeInteger(hour) ? hour : undefined
}

const Event = Schema.Struct({
  kind: Schema.Literals(eventKinds),
  sizeBucket: Schema.optionalKey(Schema.Literals(sizeBuckets)),
  relayedMegabytes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 }))),
})

const Recording = Schema.Struct({ events: Schema.Array(Event).check(Schema.isMaxLength(16)) })
const decodeRecordingResult = Schema.decodeUnknownResult(Recording)

/** The events of a `POST /record` body, or undefined when it is not one. */
export const decodeRecording = (body: unknown): readonly TelemetryEvent[] | undefined => {
  const decoded = decodeRecordingResult(body)

  return Result.isSuccess(decoded) ? decoded.success.events : undefined
}

/** What each event kind means, for the JSON counters endpoint and the dashboard. */
export const eventKindDescriptions: Readonly<Record<TelemetryEventKind, string>> = {
  "room-created": "rooms created",
  "recipient-joined": "recipients admitted to a room",
  "transfer-completed": "transfers the recipient confirmed complete",
  "transfer-failed": "transfers stopped by an abort or a limit",
  "path-direct": "transfers carried directly between browsers",
  "path-relayed": "transfers carried by the relay",
}

/**
 * The totals in OpenMetrics text (openmetrics.io), which Prometheus and Grafana read: monotonic counters since
 * counting was turned on. Hourly buckets are not exposed here, because pruning them would make the counters go down.
 */
export const toOpenMetrics = (total: TelemetrySnapshot): string => {
  const lines = [
    "# TYPE file_transfer_events counter",
    "# HELP file_transfer_events Events this instance counted since counters were turned on.",
    ...eventKinds.map((kind) => `file_transfer_events_total{kind="${kind}"} ${total.byKind[kind]}`),
    "# TYPE file_transfer_completed_by_size counter",
    "# HELP file_transfer_completed_by_size Completed transfers by size bucket.",
    ...sizeBuckets.map((bucket) => `file_transfer_completed_by_size_total{bucket="${bucket}"} ${total.bySizeBucket[bucket]}`),
    "# TYPE file_transfer_relayed_megabytes counter",
    "# HELP file_transfer_relayed_megabytes Megabytes the relay carried for transfers that ended, each rounded up.",
    `file_transfer_relayed_megabytes_total ${total.relayedMegabytes}`,
    "# EOF",
  ]

  return `${lines.join("\n")}\n`
}
