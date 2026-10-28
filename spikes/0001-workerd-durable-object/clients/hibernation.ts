/**
 * Hibernation probe: opens a sender and a recipient socket, probes the object, stays idle, probes again.
 * If the object hibernated, the second probe comes from a new instance while both sockets stayed open.
 *
 * Usage: bun clients/hibernation.ts <baseUrl> <mode> <idleSeconds...>
 */
const [baseUrl = "ws://127.0.0.1:8787", mode = "direct", ...idleArguments] = process.argv.slice(2)
const idleSeconds = idleArguments.length > 0 ? idleArguments.map(Number) : [2, 15, 75]
const session = `hibernation-${mode}-${Date.now()}`

const open = (role: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl}/relay/${session}/${role}?mode=${mode}`)
    socket.binaryType = "arraybuffer"
    socket.addEventListener("open", () => resolve(socket), { once: true })
    socket.addEventListener("error", (event) => reject(new Error(`socket error for ${role}: ${String(event)}`)), { once: true })
  })

const probe = (socket: WebSocket) =>
  new Promise<Record<string, unknown>>((resolve) => {
    socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true })
    socket.send("probe")
  })

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))

const sender = await open("sender")
const recipient = await open("recipient")
let closed = false
for (const socket of [sender, recipient]) socket.addEventListener("close", () => (closed = true))

const first = await probe(sender)
console.log(JSON.stringify({ afterIdleSeconds: 0, ...first }))
for (const seconds of idleSeconds) {
  await sleep(seconds)
  const next = await probe(recipient)
  console.log(
    JSON.stringify({
      afterIdleSeconds: seconds,
      socketsStillOpen: !closed,
      newInstance: next.instanceName !== first.instanceName,
      ...next,
    }),
  )
}
sender.close(1000)
recipient.close(1000)
