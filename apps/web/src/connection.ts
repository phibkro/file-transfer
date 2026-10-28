/**
 * One endpoint's socket to its room (docs/protocol.md): joins on open, decodes control messages and parcel units,
 * and rejoins with backoff when the socket drops, until the room refuses or the caller closes.
 */
import { decodeControlMessage, decodeUnit, encodeControlMessage, encodeUnit } from "@file-transfer/transport"
import type { ControlMessage, Role, Unit } from "@file-transfer/transport"
import { Result } from "effect"

export type ConnectionState = "connecting" | "joined" | "reconnecting" | "closed"

export interface ConnectionHandlers {
  readonly onControl: (message: ControlMessage) => void
  /** Binary units, tagged with the epoch (the join) they arrived on. */
  readonly onUnit: (unit: Unit, epoch: number) => void
  readonly onState: (state: ConnectionState) => void
}

export interface Connection {
  readonly sendControl: (message: ControlMessage) => void
  readonly sendUnit: (unit: Unit) => void
  readonly isJoined: () => boolean
  /** Counts joins; a unit from an earlier epoch arrived on a socket that has since dropped. */
  readonly epoch: () => number
  readonly close: () => void
}

export interface ConnectionOptions {
  readonly roomIdentifier: string
  readonly role: Role
  /** The room token, hex encoded; sent only in `join`. */
  readonly roomToken: string
  readonly handlers: ConnectionHandlers
}

const socketUrl = (roomIdentifier: string): string =>
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/rooms/${encodeURIComponent(roomIdentifier)}/socket`

const maximumBackoffMilliseconds = 5000

export const openConnection = (options: ConnectionOptions): Connection => {
  const { handlers } = options
  let socket: WebSocket | undefined
  let joined = false
  let epoch = 0
  let attempts = 0
  let stopped = false

  const connect = () => {
    if (stopped) {
      return
    }

    handlers.onState(attempts === 0 ? "connecting" : "reconnecting")
    const current = new WebSocket(socketUrl(options.roomIdentifier))
    current.binaryType = "arraybuffer"
    socket = current
    current.addEventListener("open", () => {
      current.send(encodeControlMessage({ type: "join", role: options.role, roomToken: options.roomToken }))
    })
    current.addEventListener("message", (event: MessageEvent) => {
      if (socket !== current) {
        return
      }

      if (typeof event.data === "string") {
        const decoded = decodeControlMessage(event.data)

        if (Result.isFailure(decoded)) {
          return
        }

        const message = decoded.success

        if (message.type === "joined") {
          joined = true
          attempts = 0
          epoch++
          handlers.onState("joined")
        }

        // The room closes the socket after an error; rejoining would only be refused again.
        if (message.type === "error") {
          stopped = true
        }

        handlers.onControl(message)

        return
      }

      if (event.data instanceof ArrayBuffer) {
        const decoded = decodeUnit(new Uint8Array(event.data))

        if (Result.isSuccess(decoded)) {
          handlers.onUnit(decoded.success, epoch)
        }
      }
    })
    current.addEventListener("close", () => {
      if (socket !== current) {
        return
      }

      joined = false
      socket = undefined

      if (stopped) {
        handlers.onState("closed")

        return
      }

      attempts++
      handlers.onState("reconnecting")
      setTimeout(connect, Math.min(maximumBackoffMilliseconds, 250 * 2 ** attempts))
    })
  }

  connect()

  return {
    sendControl: (message) => {
      if (joined) {
        socket?.send(encodeControlMessage(message))
      }
    },
    sendUnit: (unit) => {
      if (joined) {
        socket?.send(encodeUnit(unit))
      }
    },
    isJoined: () => joined,
    epoch: () => epoch,
    close: () => {
      stopped = true
      joined = false
      socket?.close(1000)
    },
  }
}
