/**
 * The Worker: room creation, the room socket upgrade, and static assets for apps/web.
 *
 *   POST /api/rooms                        {roomTokenHash, maximumRecipients} -> 201 {roomIdentifier}
 *   GET  /api/rooms/<roomIdentifier>/socket WebSocket upgrade, forwarded to the room's Durable Object
 *   anything else                          static assets, with the single-page fallback (wrangler.jsonc)
 *
 * The one invariant: request bodies and URLs are never logged; the fragment never reaches this code at all.
 */
import type { DurableObjectNamespace, Fetcher } from "cloudflare:workers"
import { decodeCreateRoom, encodeRoomIdentifier, roomIdentifierPattern } from "./room.ts"

export { RoomObject } from "./roomObject.ts"

export interface Environment {
  readonly ROOMS: DurableObjectNamespace
  readonly ASSETS: Fetcher
}

/** A creation body is two short fields; anything longer is refused unread. */
const maximumCreateBodyLength = 1024

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })

const socketPath = /^\/api\/rooms\/([^/]+)\/socket$/

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

    const socket = socketPath.exec(url.pathname)

    if (socket !== null) {
      const roomIdentifier = socket[1] ?? ""

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
