/**
 * Loopback throughput: sender socket -> Durable Object -> recipient socket, credit-based flow control.
 * The recipient starts with `windowFrames` credits and returns credits in batches of half the window as it consumes.
 * Payload is opaque random bytes from a small pool of buffers; nothing about the bytes is printed.
 *
 * Usage: bun clients/throughput.ts <baseUrl> <mode> <frameKibibytes> <totalMebibytes> <windowFrames>
 * Prints one JSON line with MB/s (10^6 bytes per second) and MiB/s.
 */
const [baseUrl = "ws://127.0.0.1:8787", mode = "direct", frameKibibytesArgument = "64", totalMebibytesArgument = "1024", windowArgument = "32"] =
  process.argv.slice(2)
const frameBytes = Number(frameKibibytesArgument) * 1024
const totalBytes = Number(totalMebibytesArgument) * 1024 * 1024
const windowFrames = Number(windowArgument)
const totalFrames = Math.ceil(totalBytes / frameBytes)
const grantBatch = Math.max(1, Math.floor(windowFrames / 2))
const session = `throughput-${mode}-${frameKibibytesArgument}-${Date.now()}`

const pool = Array.from({ length: 8 }, () => {
  const buffer = new Uint8Array(frameBytes)
  for (let offset = 0; offset < frameBytes; offset += 65536) crypto.getRandomValues(buffer.subarray(offset, Math.min(offset + 65536, frameBytes)))
  return buffer
})

/** Deployed stages require the token from alchemy.run.ts; local runs leave SPIKE_ACCESS_TOKEN unset. */
const accessToken = process.env.SPIKE_ACCESS_TOKEN ? `&token=${encodeURIComponent(process.env.SPIKE_ACCESS_TOKEN)}` : ""

const open = (role: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl}/relay/${session}/${role}?mode=${mode}${accessToken}`)
    socket.binaryType = "arraybuffer"
    socket.addEventListener("open", () => resolve(socket), { once: true })
    socket.addEventListener("error", () => reject(new Error(`socket error for ${role}`)), { once: true })
  })

const recipient = await open("recipient")
const sender = await open("sender")

let credits = 0
let framesSent = 0
let framesReceived = 0
let bytesReceived = 0
let ungranted = 0
let startedAt = 0
let closeReason = ""

const finished = new Promise<void>((resolve, reject) => {
  recipient.addEventListener("message", (event) => {
    if (typeof event.data === "string") return
    framesReceived++
    bytesReceived += (event.data as ArrayBuffer).byteLength
    ungranted++
    if (framesReceived >= totalFrames) return resolve()
    if (ungranted >= grantBatch) {
      recipient.send(`grant:${ungranted}`)
      ungranted = 0
    }
  })
  for (const socket of [sender, recipient]) {
    socket.addEventListener("close", (event) => {
      closeReason = `${event.code} ${event.reason}`
      if (framesReceived < totalFrames) reject(new Error(`closed early: ${closeReason}`))
    })
  }
})

const pump = () => {
  while (credits > 0 && framesSent < totalFrames) {
    credits--
    sender.send(pool[framesSent % pool.length]!)
    framesSent++
  }
}

sender.addEventListener("message", (event) => {
  if (typeof event.data !== "string" || !event.data.startsWith("credit:")) return
  credits += Number(event.data.slice("credit:".length))
  if (startedAt === 0) startedAt = performance.now()
  pump()
})

recipient.send(`grant:${windowFrames}`)
await finished
const seconds = (performance.now() - startedAt) / 1000
console.log(
  JSON.stringify({
    mode,
    frameKibibytes: frameBytes / 1024,
    windowFrames,
    totalMebibytes: bytesReceived / 1024 / 1024,
    seconds: Number(seconds.toFixed(2)),
    megabytesPerSecond: Number((bytesReceived / seconds / 1e6).toFixed(1)),
    mebibytesPerSecond: Number((bytesReceived / seconds / 1024 / 1024).toFixed(1)),
  }),
)
sender.close(1000)
recipient.close(1000)
