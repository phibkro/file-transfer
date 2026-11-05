import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { installLeaveGuard } from "../src/app/leaveGuard.ts"
import { currentStatus, setStatus } from "../src/capabilities/transfer/report.ts"
import { startTransfer } from "../src/features/quick-share/session.ts"
import type { SenderEvent } from "../src/features/quick-share/session.ts"

const entries = () => [{ file: new File(["content"], "example.txt"), name: "example.txt" }]

const deferred = <A>() => {
  let complete!: (value: A) => void

  const promise = new Promise<A>((resolve) => {
    complete = resolve
  })

  return { promise, resolve: complete }
}

class Socket extends EventTarget {
  static created = deferred<Socket>()
  readonly sent: (string | ArrayBufferLike | Blob | ArrayBufferView)[] = []
  binaryType = "blob"
  closed = false

  constructor(_url: string) {
    super()
    Socket.created.resolve(this)
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
  }

  receive(message: Record<string, string | number | boolean>) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }))
  }

  joinRoom() {
    this.dispatchEvent(new Event("open"))
    this.receive({ type: "joined", participantIdentifier: "sender", senderPresent: true, recipientCount: 0 })
  }
}

const setup = () => {
  const window = new EventTarget()
  vi.stubGlobal("window", window)
  vi.stubGlobal("document", { body: { dataset: {} } })
  vi.stubGlobal("location", { origin: "https://example.test", host: "example.test", protocol: "https:" })
  vi.stubGlobal("requestAnimationFrame", () => 1)
  vi.stubGlobal("RTCPeerConnection", undefined)
  Socket.created = deferred<Socket>()
  vi.stubGlobal("WebSocket", Socket)
  setStatus("idle")

  return window
}

const unloadIsPrevented = (window: EventTarget) => {
  const event = new Event("beforeunload", { cancelable: true })
  window.dispatchEvent(event)

  return event.defaultPrevented
}

const roomResponse = () => Response.json({ roomIdentifier: "abcdefghijklmnopqrstuv" }, { status: 201 })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("sender session cancellation", () => {
  it("waits for an aborted room request, clears the leave guard, and suppresses late results", async () => {
    const window = setup()
    const removeGuard = installLeaveGuard()
    const requested = deferred<AbortSignal>()
    const response = deferred<Response>()
    vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
      if (options.signal === null || options.signal === undefined) {
        throw new Error("Expected an abort signal")
      }

      requested.resolve(options.signal)

      return await response.promise
    })
    const events: SenderEvent[] = []

    const close = startTransfer(entries(), (event) => {
      events.push(event)
    })

    try {
      const signal = await requested.promise
      expect(currentStatus()).toBe("creating-room")
      expect(unloadIsPrevented(window)).toBe(true)
      let closed = false

      const closing = close().then(() => {
        closed = true

        return undefined
      })

      expect(signal.aborted).toBe(true)
      expect(currentStatus()).toBe("idle")
      expect(unloadIsPrevented(window)).toBe(false)
      expect(closed).toBe(false)
      const count = events.length
      response.resolve(roomResponse())
      await closing
      expect(events).toHaveLength(count)
      expect(currentStatus()).toBe("idle")
      await close()
      expect(events).toHaveLength(count)
    } finally {
      response.resolve(roomResponse())
      await close()
      removeGuard()
    }
  })

  it("sends an abort on a joined connection and ignores late socket events", async () => {
    const window = setup()
    const removeGuard = installLeaveGuard()
    vi.stubGlobal("fetch", async () => roomResponse())
    const events: SenderEvent[] = []

    const close = startTransfer(entries(), (event) => {
      events.push(event)
    })

    try {
      const socket = await Socket.created.promise
      socket.joinRoom()
      expect(currentStatus()).toBe("waiting-for-recipient")
      expect(unloadIsPrevented(window)).toBe(true)
      await close()
      expect(socket.closed).toBe(true)
      expect(socket.sent).toContain(JSON.stringify({ type: "abort", reason: "sender-cancelled" }))
      expect(currentStatus()).toBe("idle")
      expect(unloadIsPrevented(window)).toBe(false)
      const count = events.length
      socket.receive({ type: "peer", event: "joined", role: "recipient" })
      socket.receive({ type: "complete", sequence: 0 })
      socket.dispatchEvent(new Event("close"))
      expect(events).toHaveLength(count)
      expect(currentStatus()).toBe("idle")
    } finally {
      await close()
      removeGuard()
    }
  })

  it.each([
    [{ type: "complete", sequence: 0 }, "complete"],
    [{ type: "decline", sequence: 0 }, "declined"],
    [{ type: "abort", reason: "recipient-cancelled" }, "failed"],
  ] as const)("preserves terminal status %s on disposal", async (message, status) => {
    setup()
    vi.stubGlobal("fetch", async () => roomResponse())
    const events: SenderEvent[] = []

    const close = startTransfer(entries(), (event) => {
      events.push(event)
    })

    try {
      const socket = await Socket.created.promise
      socket.joinRoom()
      socket.receive(message)
      expect(currentStatus()).toBe(status)
      const count = events.length
      await close()
      expect(currentStatus()).toBe(status)
      expect(events).toHaveLength(count)
      expect(socket.sent).not.toContain(JSON.stringify({ type: "abort", reason: "sender-cancelled" }))
    } finally {
      await close()
    }
  })
})
