/**
 * Spike 0003: how much one room's relay carries on Cloudflare, what happens when many rooms run at once, and whether a
 * recipient that stops reading with the full credit window in flight (16 MiB) breaks anything. Speaks the room
 * protocol (docs/protocol.md) directly: create a room, join as sender and recipient, and move 64 KiB records under the
 * app's credit discipline (256 records in flight, credits returned in batches of 64). Bytes are random; nothing is
 * encrypted, because the relay neither knows nor cares.
 *
 * Usage: node --experimental-strip-types load.ts <base url> <scenario> [...]   (scenarios below; one JSON line per room on stdout)
 *
 * Runs under Node, not Bun: Bun replaces the `ws` package with its own, which cannot stop reading. `ws` can pause its TCP socket, which a browser cannot do
 * on purpose; a paused reader is how a slow phone on a bad network looks to the relay.
 */
import WebSocket from "ws"

const recordBytes = 64 * 1024
const window = 256
const creditBatch = 64

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
const sleep = async (milliseconds: number) => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const createRoom = async (base: string, roomToken: Uint8Array): Promise<string> => {
  const roomTokenHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", roomToken)))
  const response = await fetch(`${base}/api/rooms`, { method: "POST", body: JSON.stringify({ roomTokenHash, maximumRecipients: 1 }) })

  if (response.status !== 201) {
    throw new Error(`room not created: ${response.status} ${await response.text()}`)
  }

  const body = (await response.json()) as { roomIdentifier: string }

  return body.roomIdentifier
}

/** A unit frame: kind 4 (data record), sequence 0, index, then the record. */
const frame = (index: number, payload: Uint8Array): Uint8Array => {
  const bytes = new Uint8Array(9 + payload.length)
  const view = new DataView(bytes.buffer)
  view.setUint8(0, 4)
  view.setUint32(1, 0)
  view.setUint32(5, index)
  bytes.set(payload, 9)

  return bytes
}

const join = async (base: string, roomIdentifier: string, role: "sender" | "recipient", roomToken: Uint8Array) => {
  const socket = new WebSocket(`${base.replace(/^http/u, "ws")}/api/rooms/${roomIdentifier}/socket`, { perMessageDeflate: false })
  socket.binaryType = "arraybuffer"
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
  })
  const joined = new Promise<void>((resolve, reject) => {
    socket.once("message", (data) => {
      const message = JSON.parse(String(data)) as { type: string; reason?: string }
      message.type === "joined" ? resolve() : reject(new Error(`${role}: ${message.reason ?? message.type}`))
    })
  })
  socket.send(JSON.stringify({ type: "join", role, roomToken: hex(roomToken) }))
  await joined

  return socket
}

interface RoomResult {
  readonly scenario: string
  readonly rooms: number
  readonly room: number
  readonly bytes: number
  readonly seconds: number
  readonly megabytesPerSecond: number
  readonly complete: boolean
  readonly outOfOrder: number
  readonly senderClose: string
  readonly recipientClose: string
  readonly pausedMilliseconds: number
}

/** One room: `records` records from sender to recipient; the recipient stops reading for `pauseMilliseconds` once. */
const runRoom = async (base: string, scenario: string, rooms: number, room: number, records: number, pauseMilliseconds: number): Promise<RoomResult> => {
  const roomToken = crypto.getRandomValues(new Uint8Array(32))
  const roomIdentifier = await createRoom(base, roomToken)
  const sender = await join(base, roomIdentifier, "sender", roomToken)
  const recipient = await join(base, roomIdentifier, "recipient", roomToken)
  const payload = crypto.getRandomValues(new Uint8Array(recordBytes))
  let senderClose = "open"
  let recipientClose = "open"
  sender.on("close", (code, reason) => (senderClose = `${code} ${String(reason)}`))
  recipient.on("close", (code, reason) => (recipientClose = `${code} ${String(reason)}`))

  let credits = 0
  let sent = 0
  let received = 0
  let outOfOrder = 0
  let paused = false
  const started = performance.now()
  let finished = 0

  const done = new Promise<void>((resolve) => {
    recipient.on("message", (data, isBinary) => {
      if (!isBinary) {
        return
      }

      const view = new DataView(data as ArrayBuffer)

      if (view.getUint32(5) !== received) {
        outOfOrder++
      }

      received++

      if (received % creditBatch === 0 && received < records) {
        recipient.send(JSON.stringify({ type: "credit", records: creditBatch }))
      }

      // The slow phone: once the window is in flight, stop reading the socket for a while.
      if (pauseMilliseconds > 0 && !paused && received === 1) {
        paused = true
        // SAFETY: ws keeps the underlying net.Socket on `_socket`; pausing it stops reading from the network.
        const tcp = (recipient as unknown as { _socket: { pause: () => void; resume: () => void } })._socket
        tcp.pause()
        setTimeout(() => tcp.resume(), pauseMilliseconds)
      }

      if (received === records) {
        finished = performance.now()
        resolve()
      }
    })
    recipient.on("close", () => resolve())
    sender.on("close", () => resolve())
  })

  sender.on("message", (data, isBinary) => {
    if (isBinary) {
      return
    }

    const message = JSON.parse(String(data)) as { type: string; records?: number }

    if (message.type === "credit") {
      credits += message.records ?? 0
      pump()
    }
  })

  const pump = () => {
    while (credits > 0 && sent < records && sender.bufferedAmount < 8 * 1024 * 1024) {
      sender.send(frame(sent, payload))
      sent++
      credits--
    }

    if (credits > 0 && sent < records) {
      setTimeout(pump, 5)
    }
  }

  recipient.send(JSON.stringify({ type: "credit", records: Math.min(window, records) }))
  await done
  const seconds = ((finished || performance.now()) - started) / 1000
  sender.close(1000, "done")
  recipient.close(1000, "done")
  const bytes = received * recordBytes

  return {
    scenario,
    rooms,
    room,
    bytes,
    seconds: Math.round(seconds * 100) / 100,
    megabytesPerSecond: Math.round((bytes / 1e6 / seconds) * 10) / 10,
    complete: received === records,
    outOfOrder,
    senderClose,
    recipientClose,
    pausedMilliseconds: pauseMilliseconds,
  }
}

const scenarios: Readonly<Record<string, { readonly rooms: number; readonly records: number; readonly pauseMilliseconds: number }>> = {
  // One room as fast as it goes: 1 GiB.
  single: { rooms: 1, records: 16_384, pauseMilliseconds: 0 },
  // Several rooms at once: 256 MiB each.
  four: { rooms: 4, records: 4096, pauseMilliseconds: 0 },
  sixteen: { rooms: 16, records: 1024, pauseMilliseconds: 0 },
  // Slow recipients: each stops reading for 20 s with the full 16 MiB window in flight.
  slow: { rooms: 1, records: 1024, pauseMilliseconds: 20_000 },
  slowEight: { rooms: 8, records: 1024, pauseMilliseconds: 20_000 },
  slowThirtyTwo: { rooms: 32, records: 512, pauseMilliseconds: 20_000 },
}

const [base, ...names] = process.argv.slice(2)

if (base === undefined || names.length === 0) {
  throw new Error(`usage: node --experimental-strip-types load.ts <base url> <scenario...>; scenarios: ${Object.keys(scenarios).join(", ")}`)
}

for (const name of names) {
  const scenario = scenarios[name]

  if (scenario === undefined) {
    throw new Error(`unknown scenario ${name}`)
  }

  const results = await Promise.all(
    Array.from({ length: scenario.rooms }, async (_, room) => {
      try {
        return await runRoom(base, name, scenario.rooms, room, scenario.records, scenario.pauseMilliseconds)
      } catch (cause) {
        return { scenario: name, rooms: scenario.rooms, room, error: String(cause) }
      }
    }),
  )

  for (const result of results) {
    console.log(JSON.stringify(result))
  }

  await sleep(2000)
}
