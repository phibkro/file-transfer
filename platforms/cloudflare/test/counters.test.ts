import { applyEvent, emptySnapshot } from "@file-transfer/service-telemetry"
import { describe, expect, it } from "vite-plus/test"
import { countersEnabled, decodeRecording, defaultRetentionDays, hourKey, hourOf, hourOfKey, retentionDays, toOpenMetrics } from "../src/counters.ts"

describe("counter settings", () => {
  it("are off unless the operator writes on", () => {
    expect(countersEnabled({})).toBe(false)
    expect(countersEnabled({ COUNTERS: "off" })).toBe(false)
    expect(countersEnabled({ COUNTERS: "yes" })).toBe(false)
    expect(countersEnabled({ COUNTERS: " On " })).toBe(true)
  })

  it("keep 90 days of hours unless told otherwise, within 1 day and 10 years", () => {
    expect(retentionDays({})).toBe(defaultRetentionDays)
    expect(retentionDays({ COUNTERS_RETENTION_DAYS: "7" })).toBe(7)
    expect(retentionDays({ COUNTERS_RETENTION_DAYS: "0" })).toBe(defaultRetentionDays)
    expect(retentionDays({ COUNTERS_RETENTION_DAYS: "forever" })).toBe(defaultRetentionDays)
  })
})

describe("hour keys", () => {
  it("sort in time order and read back", () => {
    const hours = [0, 9, 10, 99_999, hourOf(Date.UTC(2026, 9, 29, 12))]
    const keys = hours.map(hourKey)
    expect(keys.toSorted()).toEqual(keys)
    expect(keys.map(hourOfKey)).toEqual(hours)
    expect(hourOfKey("total")).toBeUndefined()
  })
})

describe("recordings", () => {
  it("accept known kinds, buckets and whole megabytes only", () => {
    expect(
      decodeRecording({ events: [{ kind: "room-created" }, { kind: "transfer-completed", sizeBucket: "under-1-gigabyte", relayedMegabytes: 12 }] }),
    ).toHaveLength(2)
    expect(decodeRecording({ events: [{ kind: "file-name", name: "secret.pdf" }] })).toBeUndefined()
    expect(decodeRecording({ events: [{ kind: "transfer-completed", relayedMegabytes: 1.5 }] })).toBeUndefined()
    expect(decodeRecording({ events: Array.from({ length: 17 }, () => ({ kind: "room-created" })) })).toBeUndefined()
  })
})

describe("OpenMetrics", () => {
  it("renders monotonic totals and ends with EOF", () => {
    const total = applyEvent(applyEvent(emptySnapshot(), { kind: "room-created" }), {
      kind: "transfer-completed",
      sizeBucket: "under-10-megabytes",
      relayedMegabytes: 3,
    })

    const text = toOpenMetrics(total)
    expect(text).toContain('file_transfer_events_total{kind="room-created"} 1')
    expect(text).toContain('file_transfer_completed_by_size_total{bucket="under-10-megabytes"} 1')
    expect(text).toContain("file_transfer_relayed_megabytes_total 3")
    expect(text.endsWith("# EOF\n")).toBe(true)
  })
})
