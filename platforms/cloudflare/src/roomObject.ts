/**
 * The room Durable Object: a thin adapter that carries out the decisions of room.ts with the WebSocket hibernation API.
 *
 * Lifted from spikes/0001-workerd-durable-object/src/worker.ts (same repository): acceptWebSocket with attachments,
 * ArrayBuffer frames, completing the close handshake in webSocketClose. Constraints it keeps:
 * - Storage holds the room record, written once at creation, and is never written per frame (docs/decisions/0004:
 *   on celld every write delays the frames behind it). The only other writes are the idle alarm, set at creation and
 *   when the last participant leaves, and the relayed byte count, written when a socket closes.
 * - Relayed bytes (the operator's limit, limits.ts) are counted in memory on the frame path. The sender's attachment
 *   carries the count across hibernation (updated every `attachmentStepBytes`), and storage keeps it once a socket
 *   closes, so neither a pause nor a reconnect resets it.
 * - With a daily relay budget set (relayBudget.ts), the frame path reports every `reportStepFor` bytes to the budget
 *   object without waiting for the answer, and a close reports the rest; an answer that the budget is reached ends the
 *   room for every participant, as the relay limit does.
 * - No Effect runtime on the frame path (spike 0001 measured about 20% more CPU per frame through Effect).
 * - In-memory state is a cache of what the socket attachments already hold, because hibernation discards the instance.
 * - The one invariant: tokens, control message bodies and frames are never logged or stored.
 */
import { DurableObject } from "cloudflare:workers"
import type {
  DurableObjectState,
  HibernatableWebSocket,
  UpgradeResponseInit,
  WebSocketPairConstructor,
  WebSocketRequestResponsePairConstructor,
} from "cloudflare:workers"
import { fromHex, hashRoomToken } from "@file-transfer/parcel"
import { decodeControlMessage, encodeControlMessage, pingFrame, pongFrame } from "@file-transfer/transport"
import { megabytesFor, sizeBucketFor } from "@file-transfer/service-telemetry"
import type { TelemetryEvent } from "@file-transfer/service-telemetry"
import { askRelayBudget } from "./askRelayBudget.ts"
import type { BudgetEnvironment } from "./askRelayBudget.ts"
import { countersEnabled } from "./counters.ts"
import { readLimits, withinRelayLimit } from "./limits.ts"
import type { LimitVariables } from "./limits.ts"
import { recordEvents } from "./recordEvents.ts"
import { reportStepFor, stepsCrossed } from "./relayBudget.ts"
import type { CountingEnvironment } from "./recordEvents.ts"
import { dailyBudgetCloseCode, decide, decodeCreateRoom, errorReasons, joinTokenOf, messageType, relayLimitCloseCode, replacedCloseCode } from "./room.ts"
import type { Attachment, Instruction, Participant, RoomRecord } from "./room.ts"

const recordKey = "room"
const relayedKey = "relayedBytes"

/** Bytes of this room already reported to the daily relay budget, kept when a socket closes. */
const reportedKey = "reportedBytes"

/** Set once a transfer's outcome was counted, so a repeated `complete` (sent again after a reconnect) counts once. */
const outcomeKey = "outcome"

/** The sender's attachment is brought up to date with the relayed count after every this many bytes. */
const attachmentStepBytes = 16 * 1024 * 1024

/** An attachment as this adapter stores it: room.ts's, plus the room's relayed byte count when last written. */
type StoredAttachment = Attachment & { readonly relayedBytes?: number }

/** A room with no participant for this long is deleted by its alarm. */
export const idleMilliseconds = 24 * 60 * 60 * 1000

/** A global of the Workers runtime, absent from the DOM types this package compiles against. */
declare const WebSocketPair: WebSocketPairConstructor
declare const WebSocketRequestResponsePair: WebSocketRequestResponsePairConstructor

const notAdmitted: Attachment = { admitted: false }

/** `WebSocket.OPEN`, spelled out because workerd names its static constants differently from the DOM. */
const openState = 1

const json = (status: number, body: Readonly<Record<string, string>>) => Response.json(body, { status })

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

export class RoomObject extends DurableObject<LimitVariables & CountingEnvironment & BudgetEnvironment> {
  private record: RoomRecord | undefined
  /** Bytes relayed for this room so far; undefined until read from attachments or storage after a wake. */
  private relayedBytes: number | undefined
  private readonly relayLimit = readLimits(this.env).relayedBytesPerRoom
  private readonly dailyBudget = readLimits(this.env).relayedBytesPerDay
  private readonly reportStep = reportStepFor(this.dailyBudget ?? 1)
  /** Counter events waiting to be sent; only filled when the operator turned counting on (counters.ts). */
  private readonly pendingEvents: TelemetryEvent[] = []
  private relayLimitReached = false
  private dailyBudgetReached = false
  /** Admitted sockets by participant identifier, rebuilt from attachments after a wake from hibernation. */
  private sockets: Map<string, HibernatableWebSocket> | undefined
  private participants: readonly Participant[] = []
  private readonly attachments = new WeakMap<WebSocket, StoredAttachment>()

  constructor(ctx: DurableObjectState, env: LimitVariables & CountingEnvironment & BudgetEnvironment) {
    super(ctx, env)
    // Liveness (docs/protocol.md, "Liveness"): the runtime answers an endpoint's ping itself, without waking the
    // object, so a socket that went silent is noticed by the endpoint without costing the room anything.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(pingFrame, pongFrame))
  }

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
    const { 1: server } = pair
    this.ctx.acceptWebSocket(server)
    this.setAttachment(server, notAdmitted)
    const init: UpgradeResponseInit = { status: 101, webSocket: pair[0] }

    return new Response(null, init)
  }

  override async webSocketMessage(socket: HibernatableWebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message instanceof ArrayBuffer) {
      // The frame path: synchronous, no storage, no Effect.
      const relayed = this.relayedSoFar()

      if (this.attachmentOf(socket).admitted && !withinRelayLimit(relayed, message.byteLength, this.relayLimit)) {
        this.endForRelayLimit()

        return
      }

      this.countRelayed(socket, relayed, message.byteLength)
      this.carryOut(socket, decide(this.attachmentOf(socket), this.admittedParticipants(), { type: "binary" }), message)

      return
    }

    const sender = this.attachmentOf(socket)

    if (sender.admitted) {
      this.carryOut(socket, decide(sender, this.admittedParticipants(), { type: "text", text: message }))

      if (countersEnabled(this.env)) {
        const type = messageType(message)

        if (type === "complete" && sender.role === "recipient") {
          const decoded = decodeControlMessage(message)
          await this.countOutcome("completed", decoded.ok && decoded.value.type === "complete" && decoded.value.path === "direct")
        } else if (type === "abort") {
          await this.countOutcome("failed")
        }

        await this.flushEvents()
      }

      return
    }

    const token = joinTokenOf(message)
    const record = token === undefined ? undefined : await this.loadRecord()

    if (token !== undefined && this.dailyBudgetReached) {
      sendQuietly(socket, encodeControlMessage({ type: "error", reason: errorReasons.dailyBudget }))
      closeQuietly(socket, dailyBudgetCloseCode, errorReasons.dailyBudget)

      return
    }

    // A room that reached its relay limit admits nobody again.
    if (token !== undefined && (await this.loadRelayed()) >= this.relayLimit) {
      sendQuietly(socket, encodeControlMessage({ type: "error", reason: errorReasons.relayLimit }))
      closeQuietly(socket, relayLimitCloseCode, errorReasons.relayLimit)

      return
    }

    const admission =
      token === undefined || record === undefined
        ? undefined
        : { record, presentedTokenHash: await hashRoomToken(fromHex(token)), participantIdentifier: crypto.randomUUID() }

    // Decided after the last await, so no other event interleaves between reading the participants and admitting.
    // Counting waits until after, below.
    this.carryOut(
      socket,
      decide(
        this.attachmentOf(socket),
        this.admittedParticipants(),
        admission === undefined ? { type: "text", text: message } : { type: "text", text: message, admission },
      ),
    )
    await this.flushEvents()
  }

  override async webSocketClose(socket: HibernatableWebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.depart(socket)
    closeQuietly(socket, 1000, "closed")
    await this.saveRelayed()
    await this.reportRemainder()

    if (this.relayLimitReached || this.dailyBudgetReached) {
      await this.countOutcome("failed")
    }

    await this.flushEvents()
    await this.scheduleIdleCleanupIfEmpty()
  }

  override async webSocketError(socket: HibernatableWebSocket): Promise<void> {
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

  /** The relayed count without I/O: memory, or the largest count any socket's attachment carries after a wake. */
  private relayedSoFar(): number {
    this.relayedBytes ??= Math.max(0, ...this.ctx.getWebSockets().map((socket) => this.attachmentOf(socket).relayedBytes ?? 0))

    return this.relayedBytes
  }

  /** The relayed count including what storage kept from sockets that have closed. */
  private async loadRelayed(): Promise<number> {
    const stored = (await this.ctx.storage.get<number>(relayedKey)) ?? 0
    this.relayedBytes = Math.max(stored, this.relayedSoFar())

    return this.relayedBytes
  }

  private async saveRelayed() {
    const relayed = this.relayedSoFar()

    if (relayed > ((await this.ctx.storage.get<number>(relayedKey)) ?? 0)) {
      await this.ctx.storage.put(relayedKey, relayed)
    }
  }

  private countRelayed(socket: HibernatableWebSocket, before: number, frameLength: number) {
    const after = before + frameLength
    this.relayedBytes = after

    if (Math.floor(after / attachmentStepBytes) !== Math.floor(before / attachmentStepBytes)) {
      this.setAttachment(socket, { ...this.attachmentOf(socket), relayedBytes: after })
    }

    const steps = stepsCrossed(before, after, this.reportStep)

    if (this.dailyBudget !== undefined && steps > 0) {
      void this.reportToBudget(steps * this.reportStep, this.dailyBudget)
    }
  }

  /** Tells the budget object about relayed bytes, and ends the room when it answers that today's budget is reached. */
  private async reportToBudget(bytes: number, budgetBytes: number) {
    const answer = await askRelayBudget(this.env, bytes, budgetBytes)

    if (answer.budgetReached && !this.dailyBudgetReached) {
      this.dailyBudgetReached = true
      this.endRoom(dailyBudgetCloseCode, errorReasons.dailyBudget)
    }
  }

  /**
   * Reports what the steps did not: the bytes past the last whole step, once. Called when a socket closes; storage
   * keeps how much was reported, so a reconnect and a second close do not report the same bytes again.
   */
  private async reportRemainder() {
    if (this.dailyBudget === undefined) {
      return
    }

    const relayed = this.relayedSoFar()
    const reported = Math.max((await this.ctx.storage.get<number>(reportedKey)) ?? 0, Math.floor(relayed / this.reportStep) * this.reportStep)

    if (relayed > reported) {
      await this.ctx.storage.put(reportedKey, relayed)
      await this.reportToBudget(relayed - reported, this.dailyBudget)
    }
  }

  /** Counts how a transfer ended, once per room, with its relayed volume (only when counting is on). */
  /** `direct`: the recipient said some of the parcel came over a direct path (`complete` with `path`). */
  private async countOutcome(outcome: "completed" | "failed", direct = false) {
    if (!countersEnabled(this.env) || (await this.ctx.storage.get<string>(outcomeKey)) !== undefined) {
      return
    }

    await this.ctx.storage.put(outcomeKey, outcome)
    const relayed = await this.loadRelayed()
    const relayedMegabytes = megabytesFor(relayed)

    // The room knows a parcel's size only from what it relayed, so a transfer that went direct has no size bucket.
    const completed: TelemetryEvent = direct
      ? { kind: "transfer-completed", relayedMegabytes }
      : { kind: "transfer-completed", sizeBucket: sizeBucketFor(relayed), relayedMegabytes }

    this.pendingEvents.push(outcome === "completed" ? completed : { kind: "transfer-failed", relayedMegabytes }, {
      kind: direct ? "path-direct" : "path-relayed",
    })
  }

  private async flushEvents() {
    if (this.pendingEvents.length > 0) {
      await recordEvents(this.env, this.pendingEvents.splice(0))
    }
  }

  /** Tells every participant the limit was reached and closes the room to them; storage keeps the count. */
  private endForRelayLimit() {
    this.relayLimitReached = true
    this.relayedBytes = Math.max(this.relayedSoFar(), this.relayLimit)
    this.endRoom(relayLimitCloseCode, errorReasons.relayLimit)
  }

  /** Sends every participant the reason and closes the room to them; storage keeps the relayed count. */
  private endRoom(code: number, reason: string) {
    const relayedBytes = this.relayedSoFar()

    for (const socket of this.ctx.getWebSockets()) {
      this.setAttachment(socket, { admitted: false, relayedBytes })
      sendQuietly(socket, encodeControlMessage({ type: "error", reason }))
      closeQuietly(socket, code, reason)
    }

    this.sockets = undefined
    this.participants = []
    void this.ctx.storage.put(relayedKey, relayedBytes)
  }

  private async loadRecord(): Promise<RoomRecord | undefined> {
    this.record ??= await this.ctx.storage.get<RoomRecord>(recordKey)

    return this.record
  }

  private attachmentOf(socket: HibernatableWebSocket): StoredAttachment {
    const cached = this.attachments.get(socket)

    if (cached !== undefined) {
      return cached
    }

    // SAFETY: setAttachment is the only writer of attachments, and it writes a StoredAttachment.
    const stored = (socket.deserializeAttachment() as StoredAttachment | null) ?? notAdmitted
    this.attachments.set(socket, stored)

    return stored
  }

  private setAttachment(socket: HibernatableWebSocket, attachment: StoredAttachment) {
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
          // The new participant carries the room's relayed count, so a wake after hibernation finds it.
          this.setAttachment(socket, { admitted: true, ...instruction.participant, relayedBytes: this.relayedSoFar() })

          if (instruction.participant.role === "recipient" && countersEnabled(this.env)) {
            this.pendingEvents.push({ kind: "recipient-joined" })
          }

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
