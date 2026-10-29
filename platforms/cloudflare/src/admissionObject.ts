/**
 * Admission Durable Object: one per client key (a salted hash of a client address, never the address), counting the
 * rooms that key created in the current window with `admitInWindow` from services/quota. Its storage holds one window;
 * an alarm deletes it when the window ends, so nothing about a client outlives its window.
 *
 *   POST /admit  {maximumRoomsPerWindow, windowMilliseconds} -> 204, or 429 {retryAfterMilliseconds}
 */
import { DurableObject } from "cloudflare:workers"
import { admitInWindow } from "@file-transfer/service-quota"
import type { AdmissionPolicy, AdmissionWindow } from "@file-transfer/service-quota"
import { decodeAdmissionRequest } from "./limits.ts"

const windowKey = "window"

export class AdmissionObject extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const policy = decodeAdmissionRequest(await request.json().catch(() => undefined))

    if (new URL(request.url).pathname !== "/admit" || policy === undefined) {
      return Response.json({ error: "invalid admission" }, { status: 400 })
    }

    return await this.admit(policy)
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }

  private async admit(policy: AdmissionPolicy): Promise<Response> {
    const now = Date.now()
    const decision = admitInWindow(await this.ctx.storage.get<AdmissionWindow>(windowKey), now, policy)

    if (!decision.admitted) {
      return Response.json({ retryAfterMilliseconds: decision.retryAfterMilliseconds }, { status: 429 })
    }

    await this.ctx.storage.put(windowKey, decision.window)

    if (decision.window.count === 1) {
      await this.ctx.storage.setAlarm(decision.window.windowStart + policy.windowMilliseconds)
    }

    return new Response(null, { status: 204 })
  }
}
