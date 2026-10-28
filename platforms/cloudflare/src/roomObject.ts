/**
 * The room Durable Object: a thin adapter that carries out the decisions of room.ts with the WebSocket hibernation API.
 *
 * Lifted from spikes/0001-workerd-durable-object/src/worker.ts (same repository): acceptWebSocket with attachments,
 * ArrayBuffer frames, completing the close handshake in webSocketClose. Constraints it keeps:
 * - Storage holds the room record, written once at creation, and is never written per frame (docs/decisions/0004:
 *   on celld every write delays the frames behind it). The only other writes are the idle alarm, set at creation and
 *   when the last participant leaves.
 * - No Effect runtime on the frame path (spike 0001 measured about 20% more CPU per frame through Effect).
 * - In-memory state is a cache of what the socket attachments already hold, because hibernation discards the instance.
 * - The one invariant: tokens, control message bodies and frames are never logged or stored.
 */
import { DurableObject } from "cloudflare:workers"
import type { HibernatableWebSocket, UpgradeResponseInit, WebSocketPairConstructor } from "cloudflare:workers"
import { fromHex, hashRoomToken } from "@file-transfer/parcel"
import { encodeControlMessage } from "@file-transfer/transport"
import { decide, decodeCreateRoom, joinTokenOf, replacedCloseCode } from "./room.ts"
import type { Attachment, Instruction, Participant, RoomRecord } from "./room.ts"

const recordKey = "room"

/** A room with no participant for this long is deleted by its alarm. */
export const idleMilliseconds = 24 * 60 * 60 * 1000

const { WebSocketPair } = globalThis as unknown as { readonly WebSocketPair: WebSocketPairConstructor }

const notAdmitted: Attachment = { admitted: false }

/** `WebSocket.OPEN`, spelled out because workerd names its static constants differently from the DOM. */
const openState = 1

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** Sends without throwing: a socket may be closing while the room still lists it. */
const sendQuietly = (socket: WebSocket, data: string | ArrayBuffer) => {
  try {
    socket.send(data)
  } catch {
    // the close handler removes it
  }
}

const closeQuietly = (socket: WebSocket, code: number, reason: string) => {
  try {
    socket.close(code, reason)
  } catch {
    // already closed
  }
}

export class RoomObject extends DurableObject {
  private record: RoomRecord | undefined
  /** Admitted sockets by participant identifier, rebuilt from attachments after a wake from hibernation. */
  private sockets: Map<string, HibernatableWebSocket> | undefined
  private participants: readonly Participant[] = []
  private readonly attachments = new WeakMap<WebSocket, Attachment>()

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/create") {
      return await this.create(request)
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json(426, { error: "expected a WebSocket upgrade" })
    }

    if ((await this.loadRecord()) === undefined) {
      return json(404, { error: "no such room" })
    }

    const pair = new WebSocketPair()
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    this.setAttachment(server, notAdmitted)
    const init: UpgradeResponseInit = { status: 101, webSocket: pair[0] }

    return new Response(null, init)
  }

  override async webSocketMessage(socket: HibernatableWebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      // The frame path: synchronous, no storage, no Effect.
      this.carryOut(socket, decide(this.attachmentOf(socket), this.admittedParticipants(), { type: "binary" }), message)

      return
    }

    if (this.attachmentOf(socket).admitted) {
      this.carryOut(socket, decide(this.attachmentOf(socket), this.admittedParticipants(), { type: "text", text: message }))

      return
    }

    const token = joinTokenOf(message)
    const record = token === undefined ? undefined : await this.loadRecord()

    const admission =
      token === undefined || record === undefined
        ? undefined
        : { record, presentedTokenHash: await hashRoomToken(fromHex(token)), participantIdentifier: crypto.randomUUID() }

    // Decided after the last await, so no other event interleaves between reading the participants and admitting.
    this.carryOut(
      socket,
      decide(
        this.attachmentOf(socket),
        this.admittedParticipants(),
        admission === undefined ? { type: "text", text: message } : { type: "text", text: message, admission },
      ),
    )
  }

  override async webSocketClose(socket: HibernatableWebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.depart(socket)
    closeQuietly(socket, 1000, "closed")
    await this.scheduleIdleCleanupIfEmpty()
  }

  override async webSocketError(socket: HibernatableWebSocket, _error: unknown): Promise<void> {
    this.depart(socket)
    await this.scheduleIdleCleanupIfEmpty()
  }

  override async alarm(): Promise<void> {
    if (this.admittedParticipants().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + idleMilliseconds)

      return
    }

    for (const socket of this.ctx.getWebSockets()) {
      closeQuietly(socket, 1001, "room expired")
    }

    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.record = undefined
  }

  private async create(request: Request): Promise<Response> {
    const record = decodeCreateRoom(await request.json().catch(() => undefined))

    if (record === undefined) {
      return json(400, { error: "invalid room" })
    }

    if ((await this.loadRecord()) !== undefined) {
      return json(409, { error: "room exists" })
    }

    this.record = record
    await this.ctx.storage.put(recordKey, record)
    await this.ctx.storage.setAlarm(Date.now() + idleMilliseconds)

    return json(201, {})
  }

  private async loadRecord(): Promise<RoomRecord | undefined> {
    this.record ??= await this.ctx.storage.get<RoomRecord>(recordKey)

    return this.record
  }

  private attachmentOf(socket: HibernatableWebSocket): Attachment {
    const cached = this.attachments.get(socket)

    if (cached !== undefined) {
      return cached
    }

    const stored = (socket.deserializeAttachment() as Attachment | null) ?? notAdmitted
    this.attachments.set(socket, stored)

    return stored
  }

  private setAttachment(socket: HibernatableWebSocket, attachment: Attachment) {
    socket.serializeAttachment(attachment)
    this.attachments.set(socket, attachment)
  }

  private admittedSockets(): Map<string, HibernatableWebSocket> {
    if (this.sockets === undefined) {
      this.sockets = new Map()

      for (const socket of this.ctx.getWebSockets()) {
        const attachment = this.attachmentOf(socket)

        if (attachment.admitted && socket.readyState === openState) {
          this.sockets.set(attachment.participantIdentifier, socket)
        }
      }

      this.participants = this.listParticipants()
    }

    return this.sockets
  }

  private admittedParticipants(): readonly Participant[] {
    this.admittedSockets()

    return this.participants
  }

  private listParticipants(): readonly Participant[] {
    return [...(this.sockets ?? new Map<string, HibernatableWebSocket>()).values()].flatMap((socket) => {
      const attachment = this.attachmentOf(socket)

      return attachment.admitted ? [{ role: attachment.role, participantIdentifier: attachment.participantIdentifier }] : []
    })
  }

  /** Removes an admitted socket and tells the other side; a socket that was never admitted leaves silently. */
  private depart(socket: HibernatableWebSocket) {
    const attachment = this.attachmentOf(socket)

    if (!attachment.admitted) {
      return
    }

    const sockets = this.admittedSockets()
    sockets.delete(attachment.participantIdentifier)
    this.participants = this.listParticipants()
    this.setAttachment(socket, notAdmitted)
    this.carryOut(socket, decide(attachment, this.participants, { type: "close" }))
  }

  private async scheduleIdleCleanupIfEmpty() {
    if (this.admittedParticipants().length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + idleMilliseconds)
    }
  }

  private carryOut(socket: HibernatableWebSocket, instructions: readonly Instruction[], frame?: ArrayBuffer) {
    for (const instruction of instructions) {
      switch (instruction.type) {
        case "admit": {
          this.setAttachment(socket, { admitted: true, ...instruction.participant })
          this.admittedSockets().set(instruction.participant.participantIdentifier, socket)
          this.participants = this.listParticipants()
          break
        }

        case "reply": {
          sendQuietly(socket, instruction.text)
          break
        }

        case "relay": {
          for (const identifier of instruction.to) {
            const target = this.admittedSockets().get(identifier)

            if (target !== undefined) {
              sendQuietly(target, instruction.text)
            }
          }

          break
        }

        case "forwardFrame": {
          if (frame !== undefined) {
            for (const identifier of instruction.to) {
              const target = this.admittedSockets().get(identifier)

              if (target !== undefined) {
                sendQuietly(target, frame)
              }
            }
          }

          break
        }

        case "close": {
          this.depart(socket)
          closeQuietly(socket, instruction.code, instruction.reason)
          break
        }

        case "evict": {
          const target = this.admittedSockets().get(instruction.participantIdentifier)

          if (target === undefined) {
            break
          }

          this.admittedSockets().delete(instruction.participantIdentifier)
          this.participants = this.listParticipants()
          // Not admitted any more, so its eventual close (if the room ever hears it) tells nobody it left.
          this.setAttachment(target, notAdmitted)
          sendQuietly(target, encodeControlMessage({ type: "error", reason: instruction.reason }))
          closeQuietly(target, replacedCloseCode, instruction.reason)
          break
        }
      }
    }
  }
}
