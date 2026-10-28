/**
 * A TCP proxy for the end-to-end check's latency suite: it forwards every byte unchanged but holds each chunk for
 * `oneWayMilliseconds` in each direction, so a round trip through it costs twice that. Order is kept because every
 * chunk waits the same time and is queued behind the chunks before it. Bandwidth is not limited, so what it shows is
 * the effect of round-trip time alone (for example on the recipient's credit window).
 */
import type { Socket } from "bun"

interface Target {
  readonly hostname: string
  readonly port: number
}

/** Writes chunks to whichever socket `destination` returns, after a fixed delay and in order, honouring backpressure. */
const delayedWriter = (delayMilliseconds: number, destination: () => Socket | undefined) => {
  const queue: Uint8Array[] = []
  let ending = false

  const flush = () => {
    const socket = destination()

    if (socket === undefined) {
      return
    }

    while (queue.length > 0) {
      const head = queue[0]

      if (head === undefined) {
        break
      }

      const written = socket.write(head)

      if (written < head.length) {
        queue[0] = head.subarray(written)

        return
      }

      queue.shift()
    }

    if (ending) {
      socket.end()
    }
  }

  return {
    push: (chunk: Uint8Array) => {
      // Copied, since the runtime may reuse the buffer it handed us.
      const copy = chunk.slice()
      setTimeout(() => {
        queue.push(copy)
        flush()
      }, delayMilliseconds)
    },
    end: () => {
      setTimeout(() => {
        ending = true
        flush()
      }, delayMilliseconds)
    },
    flush,
  }
}

interface Connection {
  upstream?: Socket
  readonly toUpstream: ReturnType<typeof delayedWriter>
  readonly toClient: ReturnType<typeof delayedWriter>
}

export const startLatencyProxy = (target: Target, oneWayMilliseconds: number) => {
  const connections = new WeakMap<Socket, Connection>()

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (client) => {
        const connection: Connection = {
          toUpstream: delayedWriter(oneWayMilliseconds, () => connection.upstream),
          toClient: delayedWriter(oneWayMilliseconds, () => client),
        }

        connections.set(client, connection)

        const connect = async () => {
          try {
            connection.upstream = await Bun.connect({
              hostname: target.hostname,
              port: target.port,
              socket: {
                data: (_upstream, chunk) => {
                  connection.toClient.push(chunk)
                },
                drain: () => {
                  connection.toUpstream.flush()
                },
                close: () => {
                  connection.toClient.end()
                },
              },
            })
            connection.toUpstream.flush()
          } catch {
            client.end()
          }
        }

        void connect()
      },
      data: (client, chunk) => {
        connections.get(client)?.toUpstream.push(chunk)
      },
      drain: (client) => {
        connections.get(client)?.toClient.flush()
      },
      close: (client) => {
        connections.get(client)?.toUpstream.end()
      },
    },
  })

  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true)
    },
  }
}
