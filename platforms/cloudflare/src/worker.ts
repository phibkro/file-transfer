/**
 * The Worker: room creation, the room socket upgrade, and static assets for apps/web.
 *
 *   POST /api/rooms                        {roomTokenHash, maximumRecipients} -> 201 {roomIdentifier}, or 429 when the
 *                                          client address has created its hourly allowance of rooms or the instance
 *                                          has relayed its daily budget (relayBudget.ts)
 *   GET  /api/rooms/<roomIdentifier>/socket WebSocket upgrade, forwarded to the room's Durable Object
 *   GET  /api/limits                       the operator's limits a sender can act on (limits.ts)
 *   GET  /api/direct                       whether browsers may connect directly, and the STUN servers (directSettings.ts)
 *   GET  /api/instance                     the limits and whether this instance counts anything (counters.ts)
 *   GET  /api/admin/counters               totals and hourly counts as JSON      } with `Authorization: Bearer <ADMIN_TOKEN>`;
 *   GET  /api/admin/metrics                totals in OpenMetrics, for Prometheus } 404 when no ADMIN_TOKEN is set
 *   anything else                          static assets, with the single-page fallback (wrangler.jsonc)
 *
 * The one invariant: request bodies and URLs are never logged; the fragment never reaches this code at all.
 */
import type { DurableObjectNamespace, ExecutionContext, Fetcher } from "cloudflare:workers"
import { constantTimeEqual, toHex } from "@file-transfer/parcel"
import { addressSaltOf } from "./addressSalt.ts"
import type { SaltEnvironment } from "./addressSalt.ts"
import { askRelayBudget } from "./askRelayBudget.ts"
import type { BudgetEnvironment } from "./askRelayBudget.ts"
import { countersEnabled } from "./counters.ts"
import { readDirectSettings } from "./directSettings.ts"
import type { DirectVariables } from "./directSettings.ts"
import { unavailable, withOneRetry } from "./durableObjectCalls.ts"
import { publicLimits, readLimits, retryAfterMillisecondsOf } from "./limits.ts"
import type { LimitVariables, Limits } from "./limits.ts"
import { counterStore, recordEvents } from "./recordEvents.ts"
import type { CountingEnvironment } from "./recordEvents.ts"
import { decodeCreateRoom, encodeRoomIdentifier, roomIdentifierPattern } from "./room.ts"

export { AddressSaltObject } from "./addressSaltObject.ts"

export { AdmissionObject } from "./admissionObject.ts"

export { CountersObject } from "./countersObject.ts"

export { RelayBudgetObject } from "./relayBudgetObject.ts"

export { RoomObject } from "./roomObject.ts"

export interface Environment extends LimitVariables, CountingEnvironment, BudgetEnvironment, SaltEnvironment, DirectVariables {
  readonly ROOMS: DurableObjectNamespace
  readonly ADMISSION: DurableObjectNamespace
  readonly ASSETS: Fetcher
  /** Secret that opens `/api/admin/*`; without it those paths do not exist. */
  readonly ADMIN_TOKEN?: string
}

const hourMilliseconds = 60 * 60 * 1000

/** A creation body is two short fields; anything longer is refused unread. */
const maximumCreateBodyLength = 1024

const json = (status: number, body: Readonly<Record<string, string>>) => Response.json(body, { status, headers: { "cache-control": "no-store" } })

const socketPath = /^\/api\/rooms\/(?<roomIdentifier>[^/]+)\/socket$/u

/**
 * The key a client's room creations are counted under: a salted SHA-256 of its address, so a key cannot be matched to
 * an address by hashing every address. The address itself is never stored, and the key lives only as long as its
 * window (admissionObject.ts). Requests without the header (local runs) share one key.
 */
const clientKeyOf = async (request: Request, salt: string, limits: Limits): Promise<string> => {
  const address = request.headers.get(limits.clientAddressHeader) ?? "unknown"
  const material = new TextEncoder().encode(`file-transfer/admission/v1\u0000${salt}\u0000${address}`)

  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", material)))
}

/** A `429` naming the wait in seconds, for the hourly allowance and the daily budget alike. */
const tooMany = (error: string, retryAfterMilliseconds: number): Response => {
  const retryAfterSeconds = String(Math.max(1, Math.ceil(retryAfterMilliseconds / 1000)))

  return Response.json({ error, retryAfterSeconds }, { status: 429, headers: { "cache-control": "no-store", "retry-after": retryAfterSeconds } })
}

/** Asks the client key's admission object for one more room; a `Response` when refused or unreachable. */
const admit = async (request: Request, environment: Environment, limits: Limits): Promise<Response | undefined> => {
  const salt = await addressSaltOf(environment)

  if (salt === undefined) {
    return unavailable()
  }

  const clientKey = await clientKeyOf(request, salt, limits)
  const body = JSON.stringify({ maximumRoomsPerWindow: limits.roomsPerAddressPerHour, windowMilliseconds: hourMilliseconds })

  // A retry after a lost answer can count one room twice against the client; that errs on the strict side.
  const answer = await withOneRetry(
    async () => await environment.ADMISSION.get(environment.ADMISSION.idFromName(clientKey)).fetch("https://admission/admit", { method: "POST", body }),
  )

  if (!answer.reached) {
    return unavailable()
  }

  if (answer.value.status === 204) {
    return undefined
  }

  return tooMany("rate limited", retryAfterMillisecondsOf(await answer.value.json().catch(() => undefined), hourMilliseconds))
}

const createRoom = async (request: Request, environment: Environment, context: ExecutionContext): Promise<Response> => {
  const text = await request.text()

  if (text.length > maximumCreateBodyLength) {
    return json(413, { error: "body too large" })
  }

  let body: unknown

  try {
    body = JSON.parse(text)
  } catch {
    return json(400, { error: "invalid room" })
  }

  const record = decodeCreateRoom(body)

  if (record === undefined) {
    return json(400, { error: "invalid room" })
  }

  const limits = readLimits(environment)

  // Asked first, so a refused room does not use up the client's hourly allowance.
  if (limits.relayedBytesPerDay !== undefined) {
    const budget = await askRelayBudget(environment, 0, limits.relayedBytesPerDay)

    if (budget.budgetReached) {
      return tooMany("daily relay budget reached", budget.retryAfterMilliseconds)
    }
  }

  const refused = await admit(request, environment, limits)

  if (refused !== undefined) {
    return refused
  }

  // Each attempt names a new room, so a retry never meets a half-created one.
  const created = await withOneRetry(async () => {
    const candidate = encodeRoomIdentifier(crypto.getRandomValues(new Uint8Array(16)))

    const answer = await environment.ROOMS.get(environment.ROOMS.idFromName(candidate)).fetch("https://room/create", {
      method: "POST",
      body: JSON.stringify(record),
    })

    return answer.status === 201 ? candidate : undefined
  })

  if (!created.reached || created.value === undefined) {
    return unavailable()
  }

  context.waitUntil(recordEvents(environment, [{ kind: "room-created" }]))

  return json(201, { roomIdentifier: created.value })
}

/** Whether the request carries the operator's admin token; compared in constant time. */
const isOperator = (request: Request, environment: Environment): boolean => {
  const token = environment.ADMIN_TOKEN ?? ""
  const presented = request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? ""

  return token.length > 0 && constantTimeEqual(presented, token)
}

/** `/api/admin/*`: only for the operator, and only when the operator set an admin token. */
const admin = async (request: Request, environment: Environment, path: string): Promise<Response> => {
  if ((environment.ADMIN_TOKEN ?? "") === "") {
    return json(404, { error: "not found" })
  }

  if (!isOperator(request, environment)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } })
  }

  if (!countersEnabled(environment)) {
    return Response.json({ counters: false }, { headers: { "cache-control": "no-store" } })
  }

  // The counters object answers both paths itself; the Worker only checks who is asking.
  const target = path === "/api/admin/metrics" ? "https://counters/metrics" : `https://counters/snapshot${new URL(request.url).search}`
  const answer = await counterStore(environment).fetch(target)

  return new Response(answer.body, {
    status: answer.status,
    headers: { "content-type": answer.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
  })
}

export default {
  async fetch(request: Request, environment: Environment, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/api/rooms") {
      if (request.method !== "POST") {
        return json(405, { error: "method not allowed" })
      }

      return await createRoom(request, environment, context)
    }

    if (url.pathname === "/api/instance") {
      return Response.json(
        { limits: publicLimits(readLimits(environment)), counters: countersEnabled(environment) },
        { headers: { "cache-control": "no-store" } },
      )
    }

    if (url.pathname === "/api/admin/counters" || url.pathname === "/api/admin/metrics") {
      return await admin(request, environment, url.pathname)
    }

    if (url.pathname === "/api/direct") {
      return Response.json(readDirectSettings(environment), { headers: { "cache-control": "no-store" } })
    }

    if (url.pathname === "/api/limits") {
      return Response.json(publicLimits(readLimits(environment)), { headers: { "cache-control": "no-store" } })
    }

    const socket = socketPath.exec(url.pathname)

    if (socket !== null) {
      const roomIdentifier = socket.groups?.roomIdentifier ?? ""

      if (!roomIdentifierPattern.test(roomIdentifier)) {
        return json(404, { error: "no such room" })
      }

      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json(426, { error: "expected a WebSocket upgrade" })
      }

      const answer = await withOneRetry(async () => await environment.ROOMS.get(environment.ROOMS.idFromName(roomIdentifier)).fetch(request))

      return answer.reached ? answer.value : unavailable()
    }

    if (url.pathname.startsWith("/api/")) {
      return json(404, { error: "not found" })
    }

    return await environment.ASSETS.fetch(request)
  },
}
