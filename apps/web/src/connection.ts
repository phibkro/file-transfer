// oxlint-effect-plugin ignore-file:
// reason: browser glue over WebSocket and RTCPeerConnection events; moves into libraries/client with the rest of the MVP orchestration (docs/plan.md)
/**
 * One endpoint's socket to its room (docs/protocol.md): joins on open, decodes control messages and parcel units,
 * and rejoins with backoff when the socket drops, until the room refuses or the caller closes.
 *
 * With direct paths allowed (docs/decisions/0022), it also sets up a WebRTC data channel to the other side through
 * `signal` messages, and sends parcel units over it once it opens; control messages always go through the room. The
 * sender offers whenever a recipient joins; a dropped socket, or the other side leaving, closes the direct path, and
 * the next join sets it up again.
 */
import { decodeControlMessage, decodeUnit, encodeControlMessage, encodeUnit } from "@file-transfer/transport/protocol"
import type { ControlMessage, Role, Unit } from "@file-transfer/transport/protocol"
import { openDirectPath } from "./direct.ts"
import type { DirectPath } from "./direct.ts"

/** Text frames carry control messages; binary frames carry parcel units. */
const isTextFrame = (data: unknown): data is string => typeof data === "string"

export type ConnectionState = "connecting" | "joined" | "reconnecting" | "closed"

/** Which path parcel units travel: the room's relay, or directly between the browsers. */
export type PathName = "relay" | "direct"

export interface ConnectionHandlers {
  readonly onControl: (message: ControlMessage) => void
  /** Binary units, tagged with the epoch (the join) they arrived on, or the join the direct path was set up in. */
  readonly onUnit: (unit: Unit, epoch: number) => void
  readonly onState: (state: ConnectionState) => void
  /** The path units travel changed: `direct` when a direct path opened, `relay` when it closed. */
  readonly onPath?: (path: PathName) => void
}

export interface Connection {
  readonly sendControl: (message: ControlMessage) => void
  readonly sendUnit: (unit: Unit) => void
  readonly isJoined: () => boolean
  readonly path: () => PathName
  /** Whether more units can be sent now; false while the direct path's send buffer is full. */
  readonly writable: () => boolean
  /** Resolves once more units can be sent. */
  readonly untilWritable: () => Promise<void>
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
  /** STUN servers for a direct path; undefined keeps every unit on the relay. */
  readonly direct: { readonly iceServers: readonly RTCIceServer[] } | undefined
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
  let direct: DirectPath | undefined

  const sendControl = (message: ControlMessage) => {
    if (joined) {
      socket?.send(encodeControlMessage(message))
    }
  }

  /** Closes the direct path, if any; units go through the relay again. */
  const stopDirect = () => {
    const current = direct
    const wasOpen = current?.isOpen() === true
    direct = undefined
    current?.close()

    if (wasOpen) {
      handlers.onPath?.("relay")
    }
  }

  /** Sets up a new direct path (the sender offers, the recipient answers), replacing any earlier one. */
  const startDirect = (initiator: boolean) => {
    if (options.direct === undefined || stopped) {
      return
    }

    stopDirect()
    const startedIn = epoch

    const path: DirectPath = openDirectPath({
      initiator,
      iceServers: options.direct.iceServers,
      sendSignal: sendControl,
      onFrame: (frame) => {
        const decoded = decodeUnit(frame)

        if (direct === path && decoded.ok) {
          handlers.onUnit(decoded.value, startedIn)
        }
      },
      onOpen: () => {
        if (direct === path) {
          handlers.onPath?.("direct")
        }
      },
      onClose: (wasOpen) => {
        if (direct === path) {
          direct = undefined

          if (wasOpen) {
            handlers.onPath?.("relay")
          }
        }
      },
    })

    direct = path
  }

  /** Signals and presence changes that set up or close the direct path; true when the message is consumed here. */
  const steerDirect = (message: ControlMessage): boolean => {
    if (message.type === "signal") {
      if (options.role === "recipient" && message.description?.type === "offer") {
        startDirect(false)
      }

      void direct?.handleSignal(message)

      return true
    }

    const otherRole = options.role === "sender" ? "recipient" : "sender"

    if (message.type === "peer" && message.role === otherRole) {
      if (message.event === "left") {
        stopDirect()
      } else if (options.role === "sender") {
        startDirect(true)
      }
    }

    if (message.type === "joined" && options.role === "sender" && message.recipientCount > 0) {
      startDirect(true)
    }

    return false
  }

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

      if (isTextFrame(event.data)) {
        const decoded = decodeControlMessage(event.data)

        if (!decoded.ok) {
          return
        }

        const message = decoded.value

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

        if (steerDirect(message)) {
          return
        }

        handlers.onControl(message)

        return
      }

      if (event.data instanceof ArrayBuffer) {
        const decoded = decodeUnit(new Uint8Array(event.data))

        if (decoded.ok) {
          handlers.onUnit(decoded.value, epoch)
        }
      }
    })
    current.addEventListener("close", () => {
      if (socket !== current) {
        return
      }

      joined = false
      socket = undefined
      stopDirect()

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
    sendControl,
    sendUnit: (unit) => {
      const frame = encodeUnit(unit)

      if (direct?.send(frame) !== true && joined) {
        socket?.send(frame)
      }
    },
    isJoined: () => joined,
    path: () => (direct?.isOpen() === true ? "direct" : "relay"),
    writable: () => direct?.isOpen() !== true || direct.writable(),
    untilWritable: async () => {
      await direct?.untilWritable()
    },
    epoch: () => epoch,
    close: () => {
      stopped = true
      joined = false
      stopDirect()
      socket?.close(1000)
    },
  }
}
