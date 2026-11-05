import { Data, Effect, Redacted } from "effect"
import * as v from "valibot"

export const kinds = ["room-created", "recipient-joined", "transfer-completed", "transfer-failed", "path-direct", "path-relayed"] as const

const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0))

const SnapshotSchema = v.object({
  byKind: v.object({
    "room-created": count,
    "recipient-joined": count,
    "transfer-completed": count,
    "transfer-failed": count,
    "path-direct": count,
    "path-relayed": count,
  }),
  bySizeBucket: v.object({
    "under-10-megabytes": count,
    "under-1-gigabyte": count,
    "under-10-gigabytes": count,
    "10-gigabytes-or-more": count,
  }),
  relayedMegabytes: count,
})

const InstanceSchema = v.object({
  limits: v.object({ roomsPerAddressPerHour: count, relayedBytesPerRoom: count, relayedBytesPerDay: v.optional(v.nullable(count)) }),
  counters: v.boolean(),
})

const CountersSchema = v.variant("counters", [
  v.object({ counters: v.literal(false) }),
  v.object({
    counters: v.literal(true),
    kinds: v.record(v.string(), v.string()),
    total: SnapshotSchema,
    hours: v.array(v.object({ hour: count, snapshot: SnapshotSchema })),
  }),
])

export type Snapshot = v.InferOutput<typeof SnapshotSchema>

export type Instance = v.InferOutput<typeof InstanceSchema>

export type Counters = v.InferOutput<typeof CountersSchema>

export interface HourRow {
  readonly hour: number
  readonly snapshot: Snapshot | undefined
}

export class AdminDataError extends Data.TaggedError("AdminDataError") {
  static readonly description = "Operator data request failed"
}

const tokenKey = "file-transfer:admin-token"

/** Storage may be blocked by the browser; the page can still use the token in memory. */
export const readStoredToken = Effect.sync(() => {
  try {
    return Redacted.make(sessionStorage.getItem(tokenKey) ?? "")
  } catch {
    return Redacted.make("")
  }
})

export const storeToken = (token: Redacted.Redacted | undefined): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      if (token === undefined) {
        sessionStorage.removeItem(tokenKey)
      } else {
        sessionStorage.setItem(tokenKey, Redacted.value(token))
      }
    } catch {
      // Storage is optional; keep the token only in the page.
    }
  })

const getJson = (path: "/api/instance" | "/api/admin/counters?hours=48", token?: Redacted.Redacted) =>
  Effect.tryPromise({
    try: async (signal) =>
      await fetch(path, { signal, cache: "no-store", headers: token === undefined ? {} : { authorization: `Bearer ${Redacted.value(token)}` } }),
    catch: () => new AdminDataError(),
  }).pipe(
    Effect.flatMap((response) => {
      if (response.headers.get("content-type")?.includes("json") !== true) {
        return Effect.succeed({ status: response.status, body: undefined })
      }

      return Effect.tryPromise({
        try: async () => {
          const body: unknown = await response.json()

          return { body }
        },
        catch: () => new AdminDataError(),
      }).pipe(Effect.map(({ body }) => ({ status: response.status, body })))
    }),
  )

/** The fixed paths prevent credentials from being sent to an arbitrary destination. */
export const fetchInstance = getJson("/api/instance").pipe(
  Effect.map(({ status, body }) => {
    const result = v.safeParse(InstanceSchema, body)

    return { status, body: result.success ? result.output : undefined }
  }),
)

export const fetchCounters = (token: Redacted.Redacted) =>
  getJson("/api/admin/counters?hours=48", token).pipe(
    Effect.map(({ status, body }) => {
      const result = v.safeParse(CountersSchema, body)

      return { status, body: result.success ? result.output : undefined }
    }),
  )

/** Last 48 hourly buckets, including empty hours; time comes from the caller's Clock. */
export const lastHours = (hours: readonly { readonly hour: number; readonly snapshot: Snapshot }[], nowMilliseconds: number): HourRow[] => {
  const byHour = new Map(hours.map(({ hour, snapshot }) => [hour, snapshot]))
  const now = Math.floor(nowMilliseconds / 3_600_000)

  return Array.from({ length: 48 }, (_, index) => {
    const hour = now - 47 + index

    return { hour, snapshot: byHour.get(hour) }
  })
}
