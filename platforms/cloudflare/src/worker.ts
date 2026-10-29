/**
 * The Worker: room creation, the room socket upgrade, and static assets for apps/web.
 *
 *   POST /api/rooms                        {roomTokenHash, maximumRecipients} -> 201 {roomIdentifier}, or 429 when the
 *                                          client address has created its hourly allowance of rooms
 *   GET  /api/rooms/<roomIdentifier>/socket WebSocket upgrade, forwarded to the room's Durable Object
 *   GET  /api/limits                       the operator's limits a sender can act on (limits.ts)
 *   anything else                          static assets, with the single-page fallback (wrangler.jsonc)
 *
 * The one invariant: request bodies and URLs are never logged; the fragment never reaches this code at all.
 */
import type { DurableObjectNamespace, Fetcher } from "cloudflare:workers"
import { toHex } from "@file-transfer/parcel"
import { publicLimits, readLimits, retryAfterMillisecondsOf } from "./limits.ts"
import type { LimitVariables, Limits } from "./limits.ts"
import { decodeCreateRoom, encodeRoomIdentifier, roomIdentifierPattern } from "./room.ts"

export { AdmissionObject } from "./admissionObject.ts"

export { RoomObject } from "./roomObject.ts"

export interface Environment extends LimitVariables {
  readonly ROOMS: DurableObjectNamespace
  readonly ADMISSION: DurableObjectNamespace
  readonly ASSETS: Fetcher
  /** Optional secret mixed into client keys, so a key cannot be matched to an address by hashing every address. */
  readonly ADDRESS_SALT?: string
}

const hourMilliseconds = 60 * 60 * 1000

/** A creation body is two short fields; anything longer is refused unread. */
const maximumCreateBodyLength = 1024

const json = (status: number, body: Readonly<Record<string, string>>) => Response.json(body, { status, headers: { "cache-control": "no-store" } })

const socketPath = /^\/api\/rooms\/(?<roomIdentifier>[^/]+)\/socket$/u

/**
 * The key a client's room creations are counted under: a salted SHA-256 of its address. The address itself is never
 * stored, and the key lives only as long as its window (admissionObject.ts). Requests without the header (local runs)
 * share one key.
 */
const clientKeyOf = async (request: Request, environment: Environment, limits: Limits): Promise<string> => {
  const address = request.headers.get(limits.clientAddressHeader) ?? "unknown"
  const material = new TextEncoder().encode(`file-transfer/admission/v1\u0000${environment.ADDRESS_SALT ?? ""}\u0000${address}`)

  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", material)))
}

/** Asks the client key's admission object for one more room; a `Response` when refused. */
const admit = async (request: Request, environment: Environment, limits: Limits): Promise<Response | undefined> => {
  const clientKey = await clientKeyOf(request, environment, limits)
  const admission = environment.ADMISSION.get(environment.ADMISSION.idFromName(clientKey))

  const answer = await admission.fetch("https://admission/admit", {
    method: "POST",
    body: JSON.stringify({ maximumRoomsPerWindow: limits.roomsPerAddressPerHour, windowMilliseconds: hourMilliseconds }),
  })

  if (answer.status === 204) {
    return undefined
  }

  const retryAfterMilliseconds = retryAfterMillisecondsOf(await answer.json().catch(() => undefined), hourMilliseconds)

  const retryAfterSeconds = String(Math.max(1, Math.ceil(retryAfterMilliseconds / 1000)))

  return Response.json(
    { error: "rate limited", retryAfterSeconds },
    { status: 429, headers: { "cache-control": "no-store", "retry-after": retryAfterSeconds } },
  )
}

const createRoom = async (request: Request, environment: Environment): Promise<Response> => {
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

  const refused = await admit(request, environment, readLimits(environment))

  if (refused !== undefined) {
    return refused
  }

  const roomIdentifier = encodeRoomIdentifier(crypto.getRandomValues(new Uint8Array(16)))
  const room = environment.ROOMS.get(environment.ROOMS.idFromName(roomIdentifier))
  const created = await room.fetch("https://room/create", { method: "POST", body: JSON.stringify(record) })

  if (created.status !== 201) {
    return json(503, { error: "room not created" })
  }

  return json(201, { roomIdentifier })
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/api/rooms") {
      if (request.method !== "POST") {
        return json(405, { error: "method not allowed" })
      }

      return await createRoom(request, environment)
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

      return await environment.ROOMS.get(environment.ROOMS.idFromName(roomIdentifier)).fetch(request)
    }

    if (url.pathname.startsWith("/api/")) {
      return json(404, { error: "not found" })
    }

    return await environment.ASSETS.fetch(request)
  },
}
