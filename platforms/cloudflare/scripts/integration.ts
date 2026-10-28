/**
 * Integration check against wrangler dev (Miniflare on workerd): `bun run integration` from platforms/cloudflare.
 *
 * Starts the built Worker with wrangler.jsonc, serving a stub page as static assets so the check does not depend on
 * apps/web being built, then drives a room over real WebSockets: creation, admission failures, a sender and a recipient
 * relaying a contract, an accept, credits and data records, routing violations, abort and presence. Exits non-zero on
 * the first failed check. Uses the parcel test vectors' room token, so it holds no secret.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import { decodeControlMessage, encodeControlMessage, encodeUnit } from "@file-transfer/transport"
import { Result } from "effect"
import type { ControlMessage, Unit } from "@file-transfer/transport"

const roomToken = "c123f8631c7587e150411d4221c44c682b288fdeb07bc3e0224b312b8d71ff35"
const roomTokenHash = "73319e970435543e1c8bffbfc146f114897920579cc850fb0393eda79d89c085"
const wrongToken = "f".repeat(64)
const stubMarker = "integration-stub-app"

const port = 20_000 + Math.floor(Math.random() * 20_000)
const origin = `http://127.0.0.1:${port}`
const packageDirectory = new URL("..", import.meta.url).pathname
const scratch = mkdtempSync(nodePath.join(tmpdir(), "file-transfer-integration-"))

writeFileSync(nodePath.join(scratch, "index.html"), `<!doctype html><title>stub</title><p>${stubMarker}</p>`)

const environment = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", WRANGLER_SEND_METRICS: "false" }

const wrangler = Bun.spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    String(port + 1),
    "--assets",
    scratch,
    "--persist-to",
    nodePath.join(scratch, "state"),
    "--show-interactive-dev-session=false",
    "--log-level",
    "warn",
  ],
  { cwd: packageDirectory, env: environment, stdout: "ignore", stderr: "pipe" },
)

let passed = 0

/** What a failed check prints: a message, a few fields, or a value. */
type Detail = ControlMessage | string | number | Readonly<Record<string, ControlMessage | string | number | boolean>>

const check = (condition: boolean, description: string, detail?: Detail) => {
  if (!condition) {
    throw new Error(`FAILED: ${description}${detail === undefined ? "" : `\n  got: ${JSON.stringify(detail)}`}`)
  }

  passed++
  console.log(`ok ${passed} ${description}`)
}

const waitForServer = async () => {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${origin}/`)

      if (response.ok) {
        return
      }
    } catch {
      // not listening yet
    }

    await Bun.sleep(500)
  }

  throw new Error("wrangler dev did not start within 60 s")
}

/** A WebSocket client that queues what it receives, so the check can await messages in order. */
interface Client {
  readonly socket: WebSocket
  readonly opened: Promise<boolean>
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>
  readonly next: (timeoutMilliseconds?: number) => Promise<string | ArrayBuffer>
  readonly nothingWithin: (milliseconds: number) => Promise<boolean>
  readonly sendControl: (message: ControlMessage) => void
}

const connect = (roomIdentifier: string): Client => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/${roomIdentifier}/socket`)
  socket.binaryType = "arraybuffer"
  const queue: (string | ArrayBuffer)[] = []
  const waiters: ((message: string | ArrayBuffer) => void)[] = []
  socket.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
    const waiter = waiters.shift()

    if (waiter === undefined) {
      queue.push(event.data)
    } else {
      waiter(event.data)
    }
  })

  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => {
      resolve(true)
    })
    socket.addEventListener("error", () => {
      resolve(false)
    })
    socket.addEventListener("close", () => {
      resolve(false)
    })
  })

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event: CloseEvent) => {
      resolve({ code: event.code, reason: event.reason })
    })
  })

  const next = async (timeoutMilliseconds = 5000) =>
    await new Promise<string | ArrayBuffer>((resolve, reject) => {
      const queued = queue.shift()

      if (queued !== undefined) {
        resolve(queued)

        return
      }

      const timer = setTimeout(() => {
        reject(new Error("no message within the timeout"))
      }, timeoutMilliseconds)

      waiters.push((message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })

  const nothingWithin = async (milliseconds: number) => {
    await Bun.sleep(milliseconds)

    return queue.length === 0
  }

  const sendControl = (message: ControlMessage) => {
    socket.send(encodeControlMessage(message))
  }

  return { socket, opened, closed, next, nothingWithin, sendControl }
}

/** The next message, which must be a text frame holding a valid control message. */
const nextControl = async (client: Client): Promise<ControlMessage> => {
  const message = await client.next()

  if (message instanceof ArrayBuffer) {
    throw new TypeError("expected a text frame, got a binary frame")
  }

  const decoded = decodeControlMessage(message)

  if (Result.isFailure(decoded)) {
    throw new TypeError(`expected a control message, got ${message}`)
  }

  return decoded.success
}

const nextFrame = async (client: Client): Promise<Uint8Array> => {
  const message = await client.next()

  if (!(message instanceof ArrayBuffer)) {
    throw new TypeError(`expected a binary frame, got ${message}`)
  }

  return new Uint8Array(message)
}

const equalBytes = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index])

/** The body of `201` from `POST /api/rooms`. */
const isCreatedRoom = (body: unknown): body is { readonly roomIdentifier: string } =>
  typeof body === "object" && body !== null && "roomIdentifier" in body && typeof body.roomIdentifier === "string"

const createRoom = async (maximumRecipients: number): Promise<string> => {
  const response = await fetch(`${origin}/api/rooms`, { method: "POST", body: JSON.stringify({ roomTokenHash, maximumRecipients }) })
  const body: unknown = await response.json()
  const roomIdentifier = isCreatedRoom(body) ? body.roomIdentifier : ""
  check(
    response.status === 201 && /^[A-Za-z0-9_-]{22}$/u.test(roomIdentifier),
    `POST /api/rooms (maximumRecipients ${maximumRecipients}) answers 201 with a room identifier`,
    { status: response.status, roomIdentifier },
  )

  return roomIdentifier
}

/** Joins and returns the joined message. */
const joinRoom = async (client: Client, role: "sender" | "recipient", token = roomToken) => {
  check(await client.opened, `${role} socket upgrades`)
  client.sendControl({ type: "join", role, roomToken: token })

  return await nextControl(client)
}

const expectRefusal = async (client: Client, reason: string, description: string) => {
  const error = await nextControl(client)
  const { code } = await client.closed
  check(JSON.stringify(error) === JSON.stringify({ type: "error", reason }) && code === 1008, description, { error, code })
}

const unit = (kind: Unit["kind"], index: number, length: number): Uint8Array<ArrayBuffer> =>
  encodeUnit({ kind, sequence: 7, index, bytes: Uint8Array.from({ length }, (_, offset) => (offset * 31 + index * 7 + kind.length) & 0xff) })

const run = async () => {
  await waitForServer()

  // Routing and static assets.
  const app = await fetch(`${origin}/r/AAAAAAAAAAAAAAAAAAAAAA`)
  const appText = await app.text()
  check(app.status === 200 && appText.includes(stubMarker), "GET /r/<id> serves the single-page app")
  const unknownApi = await fetch(`${origin}/api/unknown`)
  check(unknownApi.status === 404 && (await unknownApi.json()) !== null, "an unknown /api path answers 404 from the Worker, not the app")
  const getRooms = await fetch(`${origin}/api/rooms`)
  check(getRooms.status === 405, "GET /api/rooms answers 405")

  for (const body of ["not json", JSON.stringify({ roomTokenHash: "abc", maximumRecipients: 1 }), JSON.stringify({ roomTokenHash, maximumRecipients: 17 })]) {
    const response = await fetch(`${origin}/api/rooms`, { method: "POST", body })
    check(response.status === 400, `POST /api/rooms refuses ${body.slice(0, 40)}`)
  }

  const plainGet = await fetch(`${origin}/api/rooms/AAAAAAAAAAAAAAAAAAAAAA/socket`)
  check(plainGet.status === 426, "the socket path without an upgrade answers 426")

  // Admission failures.
  const missing = connect("AAAAAAAAAAAAAAAAAAAAAA")
  check(!(await missing.opened), "a socket to a room that was never created is refused")
  const malformed = connect("not-a-room")
  check(!(await malformed.opened), "a socket to a malformed room identifier is refused")

  const roomIdentifier = await createRoom(1)

  const impostor = connect(roomIdentifier)
  check(
    JSON.stringify(await joinRoom(impostor, "sender", wrongToken)) === JSON.stringify({ type: "error", reason: "wrong room token" }),
    "a wrong token is refused",
  )
  const impostorClosed = await impostor.closed
  check(impostorClosed.code === 1008, "and the socket is closed with 1008")

  const early = connect(roomIdentifier)
  check(await early.opened, "a socket opens before joining")
  early.socket.send(new Uint8Array([1, 2, 3]))
  await expectRefusal(early, "join first", "a binary frame before join is refused and closed")

  // The sender and a recipient.
  const firstSender = connect(roomIdentifier)
  const senderJoined = await joinRoom(firstSender, "sender")
  check(senderJoined.type === "joined" && senderJoined.senderPresent && senderJoined.recipientCount === 0, "the sender is admitted", senderJoined)

  // A reconnecting sender replaces the one the room still holds; the old socket is told why and closed with 4000.
  const sender = connect(roomIdentifier)
  const replacingSender = await joinRoom(sender, "sender")
  check(replacingSender.type === "joined" && replacingSender.senderPresent, "a newer sender join is admitted", replacingSender)
  const replacedSender = await nextControl(firstSender)
  const { code: replacedSenderCode } = await firstSender.closed
  check(
    JSON.stringify(replacedSender) === JSON.stringify({ type: "error", reason: "replaced by a newer connection" }) && replacedSenderCode === 4000,
    "the older sender is replaced with error and close code 4000",
    { replacedSender, replacedSenderCode },
  )

  const firstRecipient = connect(roomIdentifier)
  const recipientJoined = await joinRoom(firstRecipient, "recipient")
  check(
    recipientJoined.type === "joined" && recipientJoined.senderPresent && recipientJoined.recipientCount === 1,
    "the recipient is admitted",
    recipientJoined,
  )
  check(
    JSON.stringify(await nextControl(sender)) === JSON.stringify({ type: "peer", event: "joined", role: "recipient" }),
    "the sender is told a recipient joined",
  )

  // The room was created for one recipient, so a second recipient join is a reconnect that replaces the first.
  const recipient = connect(roomIdentifier)
  const replacingRecipient = await joinRoom(recipient, "recipient")
  check(replacingRecipient.type === "joined" && replacingRecipient.recipientCount === 1, "a newer recipient join is admitted at the limit", replacingRecipient)
  const replacedRecipient = await nextControl(firstRecipient)
  const { code: replacedRecipientCode } = await firstRecipient.closed
  check(
    JSON.stringify(replacedRecipient) === JSON.stringify({ type: "error", reason: "replaced by a newer connection" }) && replacedRecipientCode === 4000,
    "the older recipient is replaced with error and close code 4000",
    { replacedRecipient, replacedRecipientCode },
  )
  check(
    JSON.stringify(await nextControl(sender)) === JSON.stringify({ type: "peer", event: "joined", role: "recipient" }),
    "the sender is told the replacing recipient joined, and not that one left",
  )

  // The contract: header and manifest records, relayed byte for byte.
  const contract = [unit("header", 0, 120), unit("manifestRecord", 0, 300), unit("manifestRecord", 1, 300)]

  for (const frame of contract) {
    sender.socket.send(frame)
  }

  for (const [index, frame] of contract.entries()) {
    check(equalBytes(await nextFrame(recipient), frame), `contract unit ${index} arrives unchanged`)
  }

  // The recipient reads the contract for longer than the 10 s after which spike 0001 saw wrangler dev evict an idle
  // object, so routing below runs on participants rebuilt from socket attachments.
  await Bun.sleep(12_000)

  // Accept and credit, relayed as sent.
  const accept = encodeControlMessage({ type: "accept", sequence: 7, digest: "d".repeat(64) })
  const credit = encodeControlMessage({ type: "credit", records: 32 })
  recipient.socket.send(accept)
  recipient.socket.send(credit)
  check((await sender.next()) === accept, "accept reaches the sender unchanged")
  check((await sender.next()) === credit, "credit reaches the sender unchanged")

  // Data records: a label page, then records of 64 KiB, in order.
  const records = [unit("labelPage", 0, 2048), ...Array.from({ length: 32 }, (_, index) => unit("dataRecord", index, 64 * 1024))]

  for (const frame of records) {
    sender.socket.send(frame)
  }

  let intact = 0

  for (const frame of records) {
    if (equalBytes(await nextFrame(recipient), frame)) {
      intact++
    }
  }

  check(intact === records.length, `${records.length} label and data units arrive unchanged and in order`, intact)

  // Routing violations.
  sender.socket.send(encodeControlMessage({ type: "credit", records: 1 }))
  await expectRefusal(sender, "the sender may only send abort", "a credit from the sender is refused and closed")
  check(
    JSON.stringify(await nextControl(recipient)) === JSON.stringify({ type: "peer", event: "left", role: "sender" }),
    "the recipient is told the sender left",
  )

  const returningSender = connect(roomIdentifier)
  const rejoined = await joinRoom(returningSender, "sender")
  check(rejoined.type === "joined" && rejoined.recipientCount === 1, "the sender can rejoin after leaving", rejoined)
  check(
    JSON.stringify(await nextControl(recipient)) === JSON.stringify({ type: "peer", event: "joined", role: "sender" }),
    "the recipient is told the sender rejoined",
  )

  const abort = encodeControlMessage({ type: "abort", reason: "cancelled by sender" })
  returningSender.socket.send(abort)
  check((await recipient.next()) === abort, "the sender's abort reaches the recipient unchanged")

  recipient.socket.send(new Uint8Array(16))
  await expectRefusal(recipient, "only the sender sends binary frames", "a binary frame from a recipient is refused and closed")
  check(
    JSON.stringify(await nextControl(returningSender)) === JSON.stringify({ type: "peer", event: "left", role: "recipient" }),
    "the sender is told the recipient left",
  )
  check(await returningSender.nothingWithin(300), "nothing else reaches the sender")
  returningSender.socket.close(1000, "done")
  await returningSender.closed

  console.log(`\nall ${passed} checks passed`)
}

let exitCode = 0

try {
  await run()
} catch (error) {
  exitCode = 1
  console.error(error instanceof Error ? error.message : error)
}

wrangler.kill()

await wrangler.exited

if (exitCode !== 0) {
  const output = await new Response(wrangler.stderr).text()

  if (output.length > 0) {
    console.error(`\nwrangler stderr:\n${output.slice(-4000)}`)
  }
}

rmSync(scratch, { recursive: true, force: true })

process.exit(exitCode)
