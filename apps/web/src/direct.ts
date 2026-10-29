// oxlint-effect-plugin ignore-file:
// reason: browser glue over RTCPeerConnection; the protocol it carries is decoded in @file-transfer/transport/protocol
/**
 * The direct path between sender and recipient (docs/decisions/0022): one WebRTC data channel, set up with `signal`
 * messages the room relays. It carries parcel units only, in the same frames as the relay (docs/protocol.md); control
 * messages stay on the room's socket. The sender offers, so the two sides never offer at once.
 *
 * The channel is reliable and unordered: SCTP retransmits what is lost, and since the recipient takes records in any
 * order (ADR 0013), one loss does not hold up the records behind it. Sending stops while more than `highWater` bytes
 * wait in the browser's buffer and resumes at `lowWater`: Chrome and Safari refuse a send once 16 MiB are queued
 * (libwebrtc `MaxSendQueueSize`, WebKit RTCDataChannel.cpp, read 2026-10-29).
 */
import type { ControlMessage } from "@file-transfer/transport/protocol"

type Signal = Extract<ControlMessage, { readonly type: "signal" }>

type Candidate = NonNullable<Signal["candidate"]>

const highWater = 1024 * 1024
const lowWater = 256 * 1024

/** A path that has not opened by then is given up; the relay carries on meanwhile. */
const openTimeoutMilliseconds = 15_000

/** RFC 8841: a peer that states no maximum message size accepts 64 KiB. */
const defaultMaximumMessageSize = 64 * 1024

export interface DirectPathOptions {
  /** The sender offers; the recipient answers. */
  readonly initiator: boolean
  readonly iceServers: readonly RTCIceServer[]
  readonly sendSignal: (message: Signal) => void
  readonly onFrame: (frame: Uint8Array) => void
  readonly onOpen: () => void
  /** The path closed or failed; `wasOpen` says whether it had carried anything. */
  readonly onClose: (wasOpen: boolean) => void
}

export interface DirectPath {
  readonly handleSignal: (message: Signal) => Promise<void>
  /** Sends a frame when the path is open and the frame fits; false means use the relay for it. */
  readonly send: (frame: Uint8Array<ArrayBuffer>) => boolean
  readonly isOpen: () => boolean
  /** Whether the browser's send buffer has room for more. */
  readonly writable: () => boolean
  /** Resolves once the send buffer has drained to `lowWater`, or the path closed. */
  readonly untilWritable: () => Promise<void>
  readonly close: () => void
}

export const openDirectPath = (options: DirectPathOptions): DirectPath => {
  const connection = new RTCPeerConnection({ iceServers: [...options.iceServers] })
  const pendingCandidates: Candidate[] = []
  const writableWaiters: (() => void)[] = []

  const wakeWaiters = () => {
    for (const resolve of writableWaiters.splice(0)) {
      resolve()
    }
  }

  let channel: RTCDataChannel | undefined
  let open = false
  let closed = false

  const close = () => {
    if (closed) {
      return
    }

    closed = true
    const wasOpen = open
    open = false
    clearTimeout(timeout)
    channel?.close()
    connection.close()
    wakeWaiters()
    options.onClose(wasOpen)
  }

  const timeout = setTimeout(() => {
    if (!open) {
      close()
    }
  }, openTimeoutMilliseconds)

  const attach = (dataChannel: RTCDataChannel) => {
    channel = dataChannel
    dataChannel.binaryType = "arraybuffer"
    dataChannel.bufferedAmountLowThreshold = lowWater
    dataChannel.addEventListener("open", () => {
      if (!closed) {
        open = true
        clearTimeout(timeout)
        options.onOpen()
      }
    })
    dataChannel.addEventListener("close", close)
    dataChannel.addEventListener("error", close)
    dataChannel.addEventListener("message", (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        options.onFrame(new Uint8Array(event.data))
      }
    })
    dataChannel.addEventListener("bufferedamountlow", wakeWaiters)
  }

  connection.addEventListener("icecandidate", (event) => {
    if (event.candidate !== null && event.candidate.candidate !== "") {
      const { candidate, sdpMid, sdpMLineIndex } = event.candidate
      options.sendSignal({ type: "signal", candidate: { candidate, sdpMid, sdpMLineIndex } })
    }
  })

  connection.addEventListener("connectionstatechange", () => {
    // "disconnected" can recover on its own; "failed" cannot.
    if (connection.connectionState === "failed" || connection.connectionState === "closed") {
      close()
    }
  })

  const writable = () => open && channel !== undefined && channel.bufferedAmount < highWater

  const addCandidate = async (candidate: Candidate) => {
    try {
      await connection.addIceCandidate({ candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null })
    } catch {
      // A candidate the browser cannot use is skipped; the others may still connect.
    }
  }

  if (options.initiator) {
    attach(connection.createDataChannel("parcel", { ordered: false }))
    void (async () => {
      try {
        const offer = await connection.createOffer()
        await connection.setLocalDescription(offer)
        options.sendSignal({ type: "signal", description: { type: "offer", sdp: offer.sdp ?? "" } })
      } catch {
        close()
      }
    })()
  } else {
    connection.addEventListener("datachannel", (event) => {
      attach(event.channel)
    })
  }

  return {
    handleSignal: async (message) => {
      if (closed) {
        return
      }

      try {
        if (message.description !== undefined) {
          await connection.setRemoteDescription(message.description)

          for (const candidate of pendingCandidates.splice(0)) {
            await addCandidate(candidate)
          }

          if (message.description.type === "offer") {
            const answer = await connection.createAnswer()
            await connection.setLocalDescription(answer)
            options.sendSignal({ type: "signal", description: { type: "answer", sdp: answer.sdp ?? "" } })
          }
        }

        if (message.candidate !== undefined) {
          if (connection.remoteDescription === null) {
            pendingCandidates.push(message.candidate)
          } else {
            await addCandidate(message.candidate)
          }
        }
      } catch {
        close()
      }
    },
    send: (frame) => {
      if (!open || channel === undefined || frame.byteLength > (connection.sctp?.maxMessageSize ?? defaultMaximumMessageSize)) {
        return false
      }

      try {
        channel.send(frame)

        return true
      } catch {
        close()

        return false
      }
    },
    isOpen: () => open,
    writable,
    untilWritable: async () => {
      if (open && !writable()) {
        await new Promise<void>((resolve) => {
          writableWaiters.push(resolve)
        })
      }
    },
    close,
  }
}
