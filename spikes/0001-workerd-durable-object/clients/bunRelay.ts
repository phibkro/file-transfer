/**
 * Control for the throughput measurement: the same relay protocol served by Bun.serve on one port, with no
 * Durable Object in between. If the client reaches much higher MB/s here, the client is not the bottleneck.
 *
 * Usage: bun clients/bunRelay.ts <port>
 */
const port = Number(process.argv[2] ?? 8790)

interface SocketData {
  readonly session: string
  readonly role: "sender" | "recipient"
}

interface Session {
  credits: number
  sender?: Bun.ServerWebSocket<SocketData>
  recipient?: Bun.ServerWebSocket<SocketData>
}

const sessions = new Map<string, Session>()
const sessionFor = (name: string) => {
  let session = sessions.get(name)
  if (session === undefined) sessions.set(name, (session = { credits: 0 }))
  return session
}

Bun.serve<SocketData, undefined>({
  port,
  hostname: "127.0.0.1",
  fetch(request, server) {
    const match = /^\/relay\/([A-Za-z0-9-]{1,64})\/(sender|recipient)$/.exec(new URL(request.url).pathname)
    if (match === null) return new Response("not found", { status: 404 })
    if (server.upgrade(request, { data: { session: match[1]!, role: match[2] as SocketData["role"] } })) return undefined
    return new Response("expected upgrade", { status: 400 })
  },
  websocket: {
    maxPayloadLength: 16 * 1024 * 1024,
    open(socket) {
      sessionFor(socket.data.session)[socket.data.role] = socket
    },
    message(socket, message) {
      const session = sessionFor(socket.data.session)
      if (typeof message === "string") {
        if (message.startsWith("grant:") && socket.data.role === "recipient") {
          session.credits += Number(message.slice("grant:".length))
          session.sender?.send(message.replace("grant:", "credit:"))
        }
        return
      }
      if (session.credits < 1) return socket.close(1008, "frame without credit")
      session.credits--
      session.recipient?.send(message)
    },
    close(socket) {
      sessions.delete(socket.data.session)
    },
  },
})
console.log(`bun relay on ${port}`)
