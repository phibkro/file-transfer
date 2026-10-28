/**
 * Credits granted before a pause longer than the eviction delay: are they still there after the object wakes?
 * The recipient grants 8 credits, the sender spends 4, everyone idles, then the sender spends the remaining 4.
 *
 * Usage: bun clients/pauseMidTransfer.ts <baseUrl> <mode> <pauseSeconds>
 */
const [baseUrl = "ws://127.0.0.1:8787", mode = "direct", pauseArgument = "12"] = process.argv.slice(2)
const session = `pause-${mode}-${Date.now()}`
/** Deployed stages require the token from alchemy.run.ts; local runs leave SPIKE_ACCESS_TOKEN unset. */
const accessToken = process.env.SPIKE_ACCESS_TOKEN ? `&token=${encodeURIComponent(process.env.SPIKE_ACCESS_TOKEN)}` : ""

const open = (role: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl}/relay/${session}/${role}?mode=${mode}${accessToken}`)
    socket.binaryType = "arraybuffer"
    socket.addEventListener("open", () => resolve(socket), { once: true })
    socket.addEventListener("error", () => reject(new Error(role)), { once: true })
  })
const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))

const recipient = await open("recipient")
const sender = await open("sender")
let received = 0
let senderClose = "open"
recipient.addEventListener("message", (event) => {
  if (typeof event.data !== "string") received++
})
sender.addEventListener("close", (event) => (senderClose = `${event.code} ${event.reason}`))

recipient.send("grant:8")
await sleep(0.5)
for (let index = 0; index < 4; index++) sender.send(new Uint8Array(1024))
await sleep(0.5)
const beforePause = received
await sleep(Number(pauseArgument))
for (let index = 0; index < 4; index++) sender.send(new Uint8Array(1024))
await sleep(1)
console.log(
  JSON.stringify({ mode, pauseSeconds: Number(pauseArgument), receivedBeforePause: beforePause, receivedAfterPause: received - beforePause, senderClose }),
)
process.exit(0)
