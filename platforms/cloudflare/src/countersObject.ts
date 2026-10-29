/**
 * Counters Durable Object: one per instance (named "counters"), keeping aggregate counts only when the operator opts in
 * (counters.ts, docs/decisions/0019-open-source-first.md). Storage holds the running totals and one snapshot per hour;
 * an alarm prunes hours older than the retention once a day. Nothing here identifies a room, a person or a file.
 *
 *   POST /record    {events: TelemetryEvent[]} -> 204
 *   GET  /snapshot  ?hours=<1..2160>           -> {counters, kinds, total, hours: [{hour, snapshot}]}
 *   GET  /metrics                              -> the totals in OpenMetrics text
 */
import { DurableObject } from "cloudflare:workers"
import { applyEvent, emptySnapshot } from "@file-transfer/service-telemetry"
import type { TelemetryEvent, TelemetrySnapshot } from "@file-transfer/service-telemetry"
import {
  decodeRecording,
  eventKindDescriptions,
  hourKey,
  hourKeyPrefix,
  hourMilliseconds,
  hourOf,
  hourOfKey,
  retentionDays,
  toOpenMetrics,
} from "./counters.ts"
import type { CounterVariables } from "./counters.ts"

const totalKey = "total"
const dayMilliseconds = 24 * hourMilliseconds
const maximumHours = 2160

export class CountersObject extends DurableObject<CounterVariables> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/record" && request.method === "POST") {
      const events = decodeRecording(await request.json().catch(() => undefined))

      if (events === undefined) {
        return Response.json({ error: "invalid recording" }, { status: 400 })
      }

      await this.record(events)

      return new Response(null, { status: 204 })
    }

    if (url.pathname === "/snapshot" && request.method === "GET") {
      const requested = Number(url.searchParams.get("hours") ?? "48")
      const hours = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), maximumHours) : 48

      return Response.json(await this.snapshot(hours))
    }

    if (url.pathname === "/metrics" && request.method === "GET") {
      const total = (await this.ctx.storage.get<TelemetrySnapshot>(totalKey)) ?? emptySnapshot()

      return new Response(toOpenMetrics(total), { headers: { "content-type": "application/openmetrics-text; version=1.0.0; charset=utf-8" } })
    }

    return Response.json({ error: "not found" }, { status: 404 })
  }

  override async alarm(): Promise<void> {
    const oldest = hourOf(Date.now()) - retentionDays(this.env) * 24
    const stored = await this.ctx.storage.list<TelemetrySnapshot>({ prefix: hourKeyPrefix, end: hourKey(oldest) })
    const expired = [...stored.keys()]

    // The storage API deletes at most 128 keys per call.
    for (let start = 0; start < expired.length; start += 128) {
      await this.ctx.storage.delete(expired.slice(start, start + 128))
    }

    await this.ctx.storage.setAlarm(Date.now() + dayMilliseconds)
  }

  private async record(events: readonly TelemetryEvent[]) {
    const key = hourKey(hourOf(Date.now()))
    let total = (await this.ctx.storage.get<TelemetrySnapshot>(totalKey)) ?? emptySnapshot()
    let hour = (await this.ctx.storage.get<TelemetrySnapshot>(key)) ?? emptySnapshot()

    for (const event of events) {
      total = applyEvent(total, event)
      hour = applyEvent(hour, event)
    }

    await this.ctx.storage.put(totalKey, total)
    await this.ctx.storage.put(key, hour)

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + dayMilliseconds)
    }
  }

  private async snapshot(hours: number) {
    const now = hourOf(Date.now())
    const stored = await this.ctx.storage.list<TelemetrySnapshot>({ prefix: hourKeyPrefix, end: hourKey(now + 1) })
    const first = now - hours + 1

    return {
      counters: true,
      kinds: eventKindDescriptions,
      total: (await this.ctx.storage.get<TelemetrySnapshot>(totalKey)) ?? emptySnapshot(),
      hours: [...stored.entries()].flatMap(([key, snapshot]) => {
        const hour = hourOfKey(key)

        return hour !== undefined && hour >= first ? [{ hour, snapshot }] : []
      }),
    }
  }
}
