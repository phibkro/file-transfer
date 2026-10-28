/**
 * Spike 0001: one Worker and one Durable Object class, run unchanged on plain workerd and under wrangler dev.
 *
 * Routes:
 *   GET /relay/<session>/<role>?mode=direct|effect   WebSocket upgrade; role is "sender" or "recipient"
 *
 * Protocol (mirrors the credit model of services/relay):
 *   recipient -> text "grant:<n>"     returns n credits; the object forwards "credit:<n>" to the sender
 *   sender    -> binary frame         spends one credit; the object forwards the bytes to the recipient
 *   any       -> text "probe"         the object answers with a JSON probe of its own state (for hibernation checks)
 *
 * Modes:
 *   direct  credits counted in a plain field, frames forwarded at once (the shape a production relay would take)
 *   effect  every push, take and grant goes through RelayReference from @file-transfer/service-relay, an Effect 4
 *           layer built once per object instance with ManagedRuntime
 *
 * The one invariant: payload bytes are never logged or stored; only counts and sizes are.
 */
import { DurableObject } from "cloudflare:workers"
import { Crypto, Effect, Layer, ManagedRuntime, Option } from "effect"
import { Relay, RelayReference, type RelaySessionIdentifier } from "../../../services/relay/src/index.ts"

interface Environment {
  readonly RELAY_SESSIONS: DurableObjectNamespace<RelaySession>
}

type Role = "sender" | "recipient"
type Mode = "direct" | "effect" | "standard" | "attached"

interface Attachment {
  /** Credits the sender may still spend; kept here in "attached" mode so they survive hibernation. */
  readonly credits?: number
  readonly role: Role
  readonly mode: Mode
  readonly connectedAtMilliseconds: number
  /** The object instance that accepted the socket; differs from the current instance after a wake from hibernation. */
  readonly acceptedByInstance: string
}

/** Effect's Crypto capability backed by the runtime's Web Crypto, as a platform layer would provide it. */
const webCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.map(
        Effect.promise(() => crypto.subtle.digest(algorithm, new Uint8Array(data))),
        (buffer) => new Uint8Array(buffer),
      ),
  }),
)

/** Runs `use` with the Relay service from the environment. */
const withRelay = <A, E>(use: (relay: Relay["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* Relay)
  })

const randomInstanceName = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join("")

/** Counts constructor runs per isolate; an increase while sockets stay open means the object hibernated and woke. */
let constructionsInThisIsolate = 0

export class RelaySession extends DurableObject<Environment> {
  private readonly instanceName = randomInstanceName()
  private readonly constructedAtMilliseconds = Date.now()
  /** In-memory state that must not survive hibernation; the probe reports it so the test can see it reset. */
  private messagesSeenByThisInstance = 0
  private directCredits = 0
  private readonly runtime = ManagedRuntime.make(Layer.provide(RelayReference, webCrypto))
  private effectSessionIdentifier: RelaySessionIdentifier | undefined

  constructor(context: DurableObjectState, environment: Environment) {
    super(context, environment)
    constructionsInThisIsolate++
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const role = url.searchParams.get("role")
    const requestedMode = url.searchParams.get("mode")
    const mode: Mode = requestedMode === "effect" || requestedMode === "standard" || requestedMode === "attached" ? requestedMode : "direct"
    if (request.headers.get("Upgrade") !== "websocket" || (role !== "sender" && role !== "recipient")) {
      return new Response("expected a WebSocket upgrade with role=sender or role=recipient", { status: 400 })
    }
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    if (mode === "standard") {
      this.acceptStandard(server, role)
      return new Response(null, { status: 101, webSocket: client })
    }
    this.ctx.acceptWebSocket(server, [role])
    const attachment: Attachment = { role, mode, connectedAtMilliseconds: Date.now(), acceptedByInstance: this.instanceName }
    server.serializeAttachment(attachment)
    if (mode === "effect" && this.effectSessionIdentifier === undefined) {
      this.effectSessionIdentifier = this.runtime.runSync(withRelay((relay) => relay.open({ initialCredits: 0 })))
    }
    await this.ctx.storage.put("socketsAccepted", ((await this.ctx.storage.get<number>("socketsAccepted")) ?? 0) + 1)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.messagesSeenByThisInstance++
    const attachment = socket.deserializeAttachment() as Attachment
    if (typeof message === "string") return this.handleText(socket, attachment, message)
    if (attachment.role !== "sender") return socket.close(1008, "only the sender sends frames")
    if (attachment.mode === "direct") return this.forwardDirect(socket, message)
    if (attachment.mode === "attached") return this.forwardAttached(socket, attachment, message)
    return this.forwardThroughEffect(socket, message)
  }

  override async webSocketClose(socket: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Closing our side completes the close handshake; the peer of a closed role is told to stop.
    try {
      socket.close(code === 1005 ? 1000 : code, "closed")
    } catch {
      // already closed
    }
  }

  private async handleText(socket: WebSocket, attachment: Attachment, text: string): Promise<void> {
    if (text === "probe") {
      const storedCount = await this.ctx.storage.get<number>("socketsAccepted")
      const effectSessionKnown =
        this.effectSessionIdentifier === undefined
          ? "no-session-in-this-instance"
          : this.runtime.runSync(
              Effect.match(
                withRelay((relay) => relay.meter(this.effectSessionIdentifier!)),
                { onFailure: (error) => error._tag, onSuccess: () => "found" },
              ),
            )
      socket.send(
        JSON.stringify({
          instanceName: this.instanceName,
          acceptedByInstance: attachment.acceptedByInstance,
          constructionsInThisIsolate,
          constructedAtMilliseconds: this.constructedAtMilliseconds,
          messagesSeenByThisInstance: this.messagesSeenByThisInstance,
          openSockets: this.ctx.getWebSockets().length,
          senders: this.ctx.getWebSockets("sender").length,
          recipients: this.ctx.getWebSockets("recipient").length,
          socketsAcceptedFromStorage: storedCount ?? 0,
          effectSessionKnown,
        }),
      )
      return
    }
    if (text.startsWith("grant:") && attachment.role === "recipient") {
      const credits = Number(text.slice("grant:".length))
      if (!Number.isSafeInteger(credits) || credits < 0) return socket.close(1008, "bad grant")
      if (attachment.mode === "direct") this.directCredits += credits
      else if (attachment.mode === "attached") this.grantAttached(credits)
      else this.grantThroughEffect(credits)
      for (const sender of this.ctx.getWebSockets("sender")) sender.send(`credit:${credits}`)
      return
    }
    socket.close(1008, "unknown control message")
  }

  private forwardDirect(sender: WebSocket, frame: ArrayBuffer): void {
    if (this.directCredits < 1) return sender.close(1008, "frame without credit")
    this.directCredits--
    for (const recipient of this.ctx.getWebSockets("recipient")) recipient.send(frame)
  }

  /** Credits live in the sender socket's attachment, which survives hibernation with the socket. */
  private grantAttached(credits: number): void {
    for (const sender of this.ctx.getWebSockets("sender")) {
      const current = sender.deserializeAttachment() as Attachment
      sender.serializeAttachment({ ...current, credits: (current.credits ?? 0) + credits })
    }
  }

  private forwardAttached(sender: WebSocket, attachment: Attachment, frame: ArrayBuffer): void {
    const credits = attachment.credits ?? 0
    if (credits < 1) return sender.close(1008, "frame without credit")
    sender.serializeAttachment({ ...attachment, credits: credits - 1 })
    for (const recipient of this.ctx.getWebSockets("recipient")) recipient.send(frame)
  }

  private grantThroughEffect(credits: number): void {
    const sessionIdentifier = this.ensureEffectSession()
    this.runtime.runSync(withRelay((relay) => relay.grant({ sessionIdentifier, credits })))
  }

  private forwardThroughEffect(sender: WebSocket, frame: ArrayBuffer): void {
    const sessionIdentifier = this.ensureEffectSession()
    const outcome = this.runtime.runSync(
      Effect.result(
        Effect.gen(function* () {
          const relay = yield* Relay
          yield* relay.push({ sessionIdentifier, frame: new Uint8Array(frame) })
          return yield* relay.take(sessionIdentifier)
        }),
      ),
    )
    if (outcome._tag === "Failure") return sender.close(1008, outcome.failure._tag)
    if (Option.isSome(outcome.success)) for (const recipient of this.ctx.getWebSockets("recipient")) recipient.send(outcome.success.value)
  }

  /** Diagnostic: the non-hibernating API (accept plus event listeners), to compare its cost with acceptWebSocket. */
  private readonly standardSockets: { sender?: WebSocket; recipient?: WebSocket } = {}
  private standardCredits = 0

  private acceptStandard(socket: WebSocket, role: Role): void {
    socket.accept()
    // With recent compatibility dates accept()-style sockets default to binaryType "blob" (the web standard);
    // forwarding a Blob with send() transmits the string "[object Blob]". The hibernation handlers get ArrayBuffer.
    socket.binaryType = "arraybuffer"
    this.standardSockets[role] = socket
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        if (role === "recipient" && event.data.startsWith("grant:")) {
          const credits = Number(event.data.slice("grant:".length))
          this.standardCredits += credits
          this.standardSockets.sender?.send(`credit:${credits}`)
        }
        return
      }
      if (role !== "sender") return
      if (this.standardCredits < 1) return socket.close(1008, "frame without credit")
      this.standardCredits--
      this.standardSockets.recipient?.send(event.data)
    })
  }

  /** After a wake from hibernation the in-memory layer is new and empty, so the session must be opened again. */
  private ensureEffectSession(): RelaySessionIdentifier {
    if (this.effectSessionIdentifier === undefined) {
      this.effectSessionIdentifier = this.runtime.runSync(withRelay((relay) => relay.open({ initialCredits: 0 })))
    }
    return this.effectSessionIdentifier
  }
}

/**
 * Diagnostic only: a relay inside the Worker isolate with no Durable Object, sharing sockets through module state.
 * This works on single-process workerd but not on Cloudflare, where requests can land in different isolates.
 */
const workerOnlySessions = new Map<string, { credits: number; sender?: WebSocket; recipient?: WebSocket }>()

const relayInWorker = (session: string, role: Role): Response => {
  let state = workerOnlySessions.get(session)
  if (state === undefined) workerOnlySessions.set(session, (state = { credits: 0 }))
  const pair = new WebSocketPair()
  const [client, server] = [pair[0], pair[1]]
  server.accept()
  state[role] = server
  const current = state
  server.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      if (role === "recipient" && event.data.startsWith("grant:")) {
        const credits = Number(event.data.slice("grant:".length))
        current.credits += credits
        current.sender?.send(`credit:${credits}`)
      }
      return
    }
    if (role !== "sender") return
    if (current.credits < 1) return server.close(1008, "frame without credit")
    current.credits--
    current.recipient?.send(event.data)
  })
  return new Response(null, { status: 101, webSocket: client })
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url)
    if (url.searchParams.get("mode") === "worker-only") {
      const workerOnly = /^\/relay\/([A-Za-z0-9-]{1,64})\/(sender|recipient)$/.exec(url.pathname)
      if (workerOnly !== null) return relayInWorker(workerOnly[1]!, workerOnly[2] as Role)
    }
    const match = /^\/relay\/([A-Za-z0-9-]{1,64})\/(sender|recipient)$/.exec(url.pathname)
    if (match === null) return new Response("not found", { status: 404 })
    const [, session, role] = match
    const forwarded = new URL(request.url)
    forwarded.searchParams.set("role", role!)
    const stub = environment.RELAY_SESSIONS.get(environment.RELAY_SESSIONS.idFromName(session!))
    return stub.fetch(new Request(forwarded, request))
  },
} satisfies ExportedHandler<Environment>
