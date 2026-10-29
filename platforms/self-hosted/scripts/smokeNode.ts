/**
 * Smoke test for a compiled server node (scripts/nodeConfig.ts): starts the binary on a free port with an empty
 * storage directory, then checks the embedded web app, the preview sandbox header, room creation and a sender joining
 * a room over a WebSocket. Runs on every platform the release builds for, Windows included.
 *
 *   bun scripts/smokeNode.ts dist/file-transfer-node
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"

const binary = process.argv[2]

if (binary === undefined) {
  throw new Error("usage: bun scripts/smokeNode.ts <binary>")
}

// The parcel test vectors' room token and its SHA-256 (as in platforms/cloudflare/scripts/integration.ts).
const roomToken = "c123f8631c7587e150411d4221c44c682b288fdeb07bc3e0224b312b8d71ff35"
const roomTokenHash = "73319e970435543e1c8bffbfc146f114897920579cc850fb0393eda79d89c085"

const port = 21_000 + Math.floor(Math.random() * 20_000)
const origin = `http://127.0.0.1:${port}`
const storage = mkdtempSync(nodePath.join(tmpdir(), "file-transfer-node-"))

const server = Bun.spawn([nodePath.resolve(binary), "--socket-addr", `http=127.0.0.1:${port}`, "--directory-path", `storage=${storage}`], {
  stdout: "inherit",
  stderr: "inherit",
})

let passed = 0

const check = (condition: boolean, description: string, detail?: string) => {
  if (!condition) {
    throw new Error(`FAILED: ${description}${detail === undefined ? "" : `\n  got: ${detail}`}`)
  }

  passed++
  console.log(`ok ${passed} ${description}`)
}

const run = async () => {
  let index: Response | undefined

  for (let attempt = 0; attempt < 60 && index === undefined; attempt++) {
    index = await fetch(`${origin}/`).catch(() => undefined)

    if (index === undefined) {
      await Bun.sleep(500)
    }
  }

  check(index !== undefined, "the node starts and listens")
  const page = (await index?.text()) ?? ""
  check(index?.status === 200 && page.includes("<title>"), "it serves the embedded web app")

  const preview = await fetch(`${origin}/preview`)
  check((preview.headers.get("content-security-policy") ?? "").includes("sandbox"), "the preview page carries its sandbox header")

  const instanceResponse = await fetch(`${origin}/api/instance`)
  const instance = await instanceResponse.text()
  check(instance.includes('"limits"'), "GET /api/instance answers", instance)

  const directResponse = await fetch(`${origin}/api/direct`)
  const direct = await directResponse.text()
  check(directResponse.status === 200 && direct.includes('"enabled":true') && direct.includes("stun:"), "GET /api/direct allows direct paths with STUN", direct)

  const created = await fetch(`${origin}/api/rooms`, { method: "POST", body: JSON.stringify({ roomTokenHash, maximumRecipients: 1 }) })
  const body = await created.text()
  check(created.status === 201, "POST /api/rooms creates a room", body)
  const roomIdentifier = /"roomIdentifier":"(?<identifier>[A-Za-z0-9_-]{22})"/u.exec(body)?.groups?.identifier ?? ""

  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/${roomIdentifier}/socket`)

  const answer = await new Promise<string>((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "join", role: "sender", roomToken }))
    })
    socket.addEventListener("message", (event) => {
      resolve(String(event.data))
    })
    socket.addEventListener("error", () => {
      reject(new Error("socket error"))
    })
    setTimeout(() => {
      reject(new Error("no answer within 10 s"))
    }, 10_000)
  })

  check(answer.includes('"joined"'), "a sender joins the room over a WebSocket", answer)
  socket.close(1000, "done")
}

let exitCode = 0

try {
  await run()
  console.log(`\nall ${passed} checks passed`)
} catch (error) {
  exitCode = 1
  console.error(error instanceof Error ? error.message : error)
}

server.kill()

await server.exited

rmSync(storage, { recursive: true, force: true })

process.exit(exitCode)
