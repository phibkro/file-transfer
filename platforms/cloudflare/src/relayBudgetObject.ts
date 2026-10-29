/**
 * Relay budget Durable Object: one per instance (named "relay-budget"), keeping the bytes all rooms relayed today
 * (relayBudget.ts). Storage holds one small record, overwritten each day; nothing in it identifies a room or a person.
 *
 *   POST /report  {bytes, budgetBytes} -> {budgetReached, retryAfterMilliseconds}   (bytes 0 only asks)
 */
import { DurableObject } from "cloudflare:workers"
import { addRelayed, answerFor, decodeBudgetReport } from "./relayBudget.ts"
import type { BudgetDay } from "./relayBudget.ts"

const dayKey = "day"

export class RelayBudgetObject extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const report = decodeBudgetReport(await request.json().catch(() => undefined))

    if (new URL(request.url).pathname !== "/report" || request.method !== "POST" || report === undefined) {
      return Response.json({ error: "invalid report" }, { status: 400 })
    }

    const now = Date.now()
    const day = addRelayed(await this.ctx.storage.get<BudgetDay>(dayKey), now, report.bytes)

    if (report.bytes > 0) {
      await this.ctx.storage.put(dayKey, day)
    }

    return Response.json(answerFor(day, now, report.budgetBytes))
  }
}
