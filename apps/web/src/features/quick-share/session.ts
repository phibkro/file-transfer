// oxlint-effect-plugin ignore-file:
// reason: MVP transfer orchestration in plain TypeScript over browser Promises (Web Crypto, Blob, fetch); it moves into libraries/client as Effect services once the MVP proves out (docs/plan.md)
/**
 * Prepare and serve a parcel to the recipient that accepts it
 * (docs/protocol.md, "Order of a transfer"). One recipient, sequence number 0.
 */
import * as v from "valibot"
import {
  bytesEqual,
  createManifest,
  createParcelSealer,
  createSecret,
  deriveRoomToken,
  encodeLinkSecret,
  hashRoomToken,
  isParcelError,
  isValidMediaType,
  labelRecords,
  labelsPerPage,
  leafHash,
  ParcelError,
  recordReaderFromBlob,
  toHex,
} from "@file-transfer/parcel"
import type { Contract, ManifestFile, ParcelSealer, RecordReader } from "@file-transfer/parcel"
import type { ControlMessage } from "@file-transfer/transport/protocol"
import { pageOrigin } from "../../app/address.ts"
import { buildPath } from "../../app/routes.ts"
import { receiveCredit, spendCredit } from "../../capabilities/connection/credits.ts"
import type { CreditBalance } from "../../capabilities/connection/credits.ts"
import { openConnection } from "../../capabilities/connection/connection.ts"
import type { Connection, PathName } from "../../capabilities/connection/connection.ts"
import { directOption } from "../../capabilities/connection/directSettings.ts"
import {
  addRecord,
  createRecordSet,
  createSchedule,
  markSent,
  peekNext,
  prioritise,
  rangesAreValid,
  replaceDebt,
} from "../../capabilities/connection/ranges.ts"
import type { Schedule } from "../../capabilities/connection/ranges.ts"
import { setPath, setProgress, setStatus, setTotalBytes } from "../../capabilities/transfer/report.ts"

const sequence = 0

interface Prepared {
  readonly sealer: ParcelSealer
  readonly contract: Contract
  readonly readRecord: RecordReader
  readonly linkSecret: Uint8Array
}

/** A chosen file and the name it is sent under, which the sender may change until the parcel is sealed. */
export interface SenderEntry {
  readonly file: File
  readonly name: string
}

const manifestEntry = ({ file, name }: SenderEntry): ManifestFile => {
  const mediaType = file.type.toLowerCase()

  return { name, size: file.size, mediaType: isValidMediaType(mediaType) ? mediaType : "" }
}

/** A failure outside the parcel library, named by a reason code like a `ParcelError`. */
class TransferError extends Error {
  override readonly name = "TransferError"
  readonly reason: string
  /** A sentence to show after the reason's description, such as how long to wait. */
  readonly detail: string | undefined

  constructor(reason: string, detail?: string) {
    super(reason)
    this.reason = reason
    this.detail = detail
  }
}

/** What to show after a failure's description: a parcel error's message, or a transfer error's detail. */
const detailOf = (cause: unknown): string | undefined => {
  if (isParcelError(cause)) {
    return cause.message
  }

  return cause instanceof TransferError ? cause.detail : undefined
}

/** "about 12 minutes" from a `Retry-After` header in seconds; the hour when the header is missing. */
const waitText = (retryAfter: string | null): string => {
  const minutes = Math.max(1, Math.ceil(Number(retryAfter ?? "3600") / 60))

  if (!Number.isFinite(minutes)) {
    return "an hour"
  }

  if (minutes >= 90) {
    return `about ${Math.round(minutes / 60)} hours`
  }

  return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`
}

const Refusal = v.object({ error: v.string() })

/** The `error` a refusal names, such as the daily relay budget; undefined when the body names none. */
const refusalOf = async (response: Response): Promise<string | undefined> => {
  const decoded = v.safeParse(Refusal, await response.json().catch(() => undefined))

  return decoded.success ? decoded.output.error : undefined
}

/** The body of `201` from `POST /api/rooms`. */
const isCreatedRoom = (body: unknown): body is { readonly roomIdentifier: string } =>
  typeof body === "object" && body !== null && "roomIdentifier" in body && typeof body.roomIdentifier === "string"

const reasonOf = (cause: unknown): string => {
  if (isParcelError(cause) || cause instanceof TransferError) {
    return cause.reason
  }

  // A File whose bytes changed on disk after it was picked can no longer be read.
  if (cause instanceof DOMException && cause.name === "NotReadableError") {
    return "source-changed"
  }

  return "sender-error"
}

/** Labels every record, showing progress, and seals the contract. */
const prepare = async (entries: readonly SenderEntry[], onProgress: (done: number, total: number) => void): Promise<Prepared> => {
  const manifest = createManifest(entries.map(manifestEntry))
  const linkSecret = createSecret()
  const sealer = await createParcelSealer({ linkSecret, sequence, manifest })
  const readRecord = recordReaderFromBlob(new Blob(entries.map((entry) => entry.file)), sealer.recordSize)
  let labelled = 0

  const labels = await labelRecords(sealer, async (index, length) => {
    const bytes = await readRecord(index, length)
    labelled++
    onProgress(labelled, sealer.recordCount)

    return bytes
  })

  return { sealer, contract: await sealer.sealContract(labels), readRecord, linkSecret }
}

const requestRoom = async (roomTokenHash: string, signal: AbortSignal): Promise<Response> =>
  await fetch("/api/rooms", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomTokenHash, maximumRecipients: 1 }),
  })

const createRoom = async (roomTokenHash: string, signal: AbortSignal): Promise<string> => {
  let response = await requestRoom(roomTokenHash, signal)

  // A server error names no room, so asking once more after a second is safe (docs/spikes/0003-relay-load.md).
  if (response.status >= 500) {
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted()

      const onAbort = () => {
        clearTimeout(timer)
        reject(new DOMException("Transfer cancelled", "AbortError"))
      }

      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      }, 1000)

      signal.addEventListener("abort", onAbort, { once: true })
    })
    signal.throwIfAborted()
    response = await requestRoom(roomTokenHash, signal)
  }

  if (response.status === 429) {
    const wait = `Try again in ${waitText(response.headers.get("retry-after"))}.`

    throw new TransferError((await refusalOf(response)) === "daily relay budget reached" ? "daily relay budget reached" : "rate-limited", wait)
  }

  if (response.status !== 201) {
    throw new TransferError("room-not-created")
  }

  const body: unknown = await response.json()

  if (!isCreatedRoom(body)) {
    throw new TransferError("room-not-created")
  }

  return body.roomIdentifier
}

export type SenderEvent =
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "progress"; readonly phase: "sealing" | "sending"; readonly done: number; readonly total: number }
  | { readonly type: "link"; readonly link: string }
  | { readonly type: "failure"; readonly reason: string; readonly detail?: string }
  | { readonly type: "finished"; readonly status: "complete" | "declined" }

type Publish = (event: SenderEvent) => void

/**
 * Serves one prepared parcel through the room until the recipient completes, declines or aborts. Units go over a
 * direct path when one opens (`direct`, docs/decisions/0022) and over the relay otherwise; credits govern both.
 */
const serve = (
  prepared: Prepared,
  roomIdentifier: string,
  roomToken: string,
  publish: Publish,
  direct: { readonly iceServers: readonly RTCIceServer[] } | undefined,
) => {
  const { sealer, contract, readRecord } = prepared
  const digest = toHex(contract.digest)
  const everSent = createRecordSet(contract.recordCount)
  const balance: CreditBalance = { available: 0 }
  const pagesSent = new Set<number>()
  const pendingPumps = new Set<Promise<void>>()
  let schedule: Schedule | undefined
  let awaitingFirstCredit = false
  let session = 0
  let pumping = false
  let finished = false

  const finish = (status: "complete" | "declined" | "failed", reason?: string) => {
    if (finished) {
      return
    }

    finished = true
    session++
    connection.close()
    setStatus(status, reason)

    if (status === "complete") {
      publish({ type: "finished", status: "complete" })
    } else if (status === "declined") {
      publish({ type: "finished", status: "declined" })
    } else {
      publish({ type: "failure", reason: reason ?? "sender-error" })
    }
  }

  const fail = (cause: unknown) => {
    if (finished) {
      return
    }

    const reason = reasonOf(cause)
    connection.sendControl({ type: "abort", reason })
    finish("failed", reason)
  }

  /** A recipient is present: start a fresh session by offering the contract. */
  const offerContract = () => {
    session++
    schedule = undefined
    balance.available = 0
    pagesSent.clear()
    connection.sendUnit({ kind: "header", sequence, index: 0, bytes: contract.header.bytes })

    for (const [index, bytes] of contract.manifestRecords.entries()) {
      connection.sendUnit({ kind: "manifestRecord", sequence, index, bytes })
    }

    setStatus("offering")
    publish({ type: "status", text: "The recipient is looking at the files." })
  }

  const pump = async () => {
    if (pumping) {
      return
    }

    pumping = true

    try {
      while (!finished && schedule !== undefined && balance.available > 0 && connection.isJoined() && connection.writable()) {
        const index = peekNext(schedule)

        if (index === undefined) {
          break
        }

        const current = session
        const page = Math.floor(index / labelsPerPage)

        if (!pagesSent.has(page)) {
          const pageBytes = await contract.labelPage(page)

          if (current !== session) {
            continue
          }

          connection.sendUnit({ kind: "labelPage", sequence, index: page, bytes: pageBytes })
          pagesSent.add(page)
        }

        const record = await sealer.sealData(index, await readRecord(index, sealer.dataPlaintextLength(index)))

        if (!bytesEqual(await leafHash(record), contract.labelOf(index))) {
          throw new ParcelError("source-changed", `data record ${index} changed since the contract was sealed`)
        }

        if (current !== session || !spendCredit(balance)) {
          continue
        }

        connection.sendUnit({ kind: "dataRecord", sequence, index, bytes: record })
        markSent(schedule, index)
        addRecord(everSent, index)
        setProgress(everSent.count, contract.recordCount)
        publish({ type: "progress", phase: "sending", done: everSent.count, total: contract.recordCount })
      }
    } catch (error) {
      fail(error)
    } finally {
      pumping = false
    }

    // The direct path's send buffer is full: carry on once it drains.
    if (!finished && schedule !== undefined && balance.available > 0 && !connection.writable()) {
      await connection.untilWritable()
      await pump()
    }
  }

  const startPump = () => {
    if (finished) {
      return
    }

    const work = pump()
    pendingPumps.add(work)
    void work.then(
      () => pendingPumps.delete(work),
      () => pendingPumps.delete(work),
    )
  }

  const onPath = (path: PathName) => {
    if (finished) {
      return
    }

    setPath(path)
    startPump()
  }

  const onControl = (message: ControlMessage) => {
    if (finished) {
      return
    }

    switch (message.type) {
      case "joined": {
        if (message.recipientCount > 0) {
          offerContract()
        } else {
          setStatus("waiting-for-recipient")
          publish({ type: "status", text: "Waiting for the recipient to open the link." })
        }

        return
      }

      case "peer": {
        if (message.role !== "recipient") {
          return
        }

        if (message.event === "joined") {
          offerContract()
        } else {
          session++
          schedule = undefined
          setStatus("waiting-for-recipient")
          publish({ type: "status", text: "The recipient disconnected. Waiting for them to come back." })
        }

        return
      }

      case "accept": {
        if (message.sequence !== sequence || message.digest !== digest) {
          fail(new ParcelError("contract-mismatch", "the recipient accepted a different contract"))

          return
        }

        session++
        schedule = createSchedule(contract.recordCount)
        awaitingFirstCredit = true
        balance.available = 0
        pagesSent.clear()
        setStatus("transferring")
        setProgress(everSent.count, contract.recordCount)
        publish({ type: "status", text: "Sending." })

        return
      }

      case "decline": {
        if (message.sequence === sequence) {
          finish("declined")
        }

        return
      }

      case "credit": {
        if (schedule === undefined) {
          return
        }

        receiveCredit(balance, message.records)
        awaitingFirstCredit = false
        startPump()

        return
      }

      case "want": {
        if (schedule === undefined || message.sequence !== sequence || !rangesAreValid(message.ranges, contract.recordCount)) {
          return
        }

        if (awaitingFirstCredit) {
          replaceDebt(schedule, message.ranges)
        } else {
          prioritise(schedule, message.ranges)
        }

        // Answer with the covering label pages first: the recipient may have released them.
        for (const [start, end] of message.ranges) {
          for (let page = Math.floor(start / labelsPerPage); page <= Math.floor((end - 1) / labelsPerPage); page++) {
            pagesSent.delete(page)
          }
        }

        startPump()

        return
      }

      case "complete": {
        if (message.sequence === sequence) {
          setProgress(contract.recordCount, contract.recordCount)
          publish({ type: "progress", phase: "sending", done: contract.recordCount, total: contract.recordCount })
          finish("complete")
        }

        return
      }

      case "abort": {
        finish("failed", message.reason)

        return
      }

      case "error": {
        finish("failed", message.reason)

        break
      }

      // Messages a sender never receives here: `signal` is the connection's own (connection.ts).
      case "join":
      case "signal": {
        break
      }
    }
  }

  const connection: Connection = openConnection({
    roomIdentifier,
    role: "sender",
    roomToken,
    direct,
    handlers: {
      onControl,
      onPath,
      onUnit: () => {
        // The sender receives no parcel units.
      },
      onState: (state) => {
        if (finished) {
          return
        }

        if (state === "reconnecting") {
          session++
          schedule = undefined
          setStatus("reconnecting")
          publish({ type: "status", text: "Connection lost. Reconnecting." })
        }
      },
    },
  })

  return async () => {
    if (!finished) {
      finished = true
      session++
      schedule = undefined
      connection.sendControl({ type: "abort", reason: "sender-cancelled" })
      connection.close()
    }

    await Promise.all(pendingPumps)
  }
}

/** Start one transfer. The returned cleanup prevents later publications and closes its connection. */
export const startTransfer = (entries: readonly SenderEntry[], onEvent: (event: SenderEvent) => void): (() => Promise<void>) => {
  let stopped = false
  let terminal = false
  let stopServing: (() => Promise<void>) | undefined
  const abort = new AbortController()

  const publish: Publish = (event) => {
    if (event.type === "finished" || event.type === "failure") {
      terminal = true
    }

    if (!stopped) {
      onEvent(event)
    }
  }

  const begin = async () => {
    const total = entries.reduce((sum, entry) => sum + entry.file.size, 0)
    setTotalBytes(total)
    setStatus("labelling")
    publish({ type: "status", text: "Sealing parcel." })

    try {
      const prepared = await prepare(entries, (done, count) => {
        abort.signal.throwIfAborted()
        setProgress(done, count)
        publish({ type: "progress", phase: "sealing", done, total: count })
      })

      abort.signal.throwIfAborted()
      setStatus("creating-room")
      publish({ type: "status", text: "Opening a room." })
      const roomToken = await deriveRoomToken(prepared.linkSecret)
      abort.signal.throwIfAborted()
      const tokenHash = await hashRoomToken(roomToken)
      abort.signal.throwIfAborted()
      const roomIdentifier = await createRoom(tokenHash, abort.signal)
      abort.signal.throwIfAborted()
      const pathname = buildPath("/r/$roomIdentifier", { roomIdentifier })

      if (pathname === undefined) {
        throw new TransferError("room-not-created")
      }

      const link = `${pageOrigin()}${pathname}#${encodeLinkSecret(prepared.linkSecret)}`
      publish({ type: "link", link })
      abort.signal.throwIfAborted()
      const direct = await directOption()
      abort.signal.throwIfAborted()
      stopServing = serve(prepared, roomIdentifier, toHex(roomToken), publish, direct)
      setProgress(0, prepared.contract.recordCount)
      publish({ type: "progress", phase: "sending", done: 0, total: prepared.contract.recordCount })
    } catch (error) {
      if (stopped) {
        return
      }

      const reason = reasonOf(error)
      setStatus("failed", reason)
      const detail = detailOf(error)
      publish(detail === undefined ? { type: "failure", reason } : { type: "failure", reason, detail })
    }
  }

  const beginning = begin()
  let closing: Promise<void> | undefined

  return async () => {
    if (closing !== undefined) {
      await closing

      return
    }

    stopped = true

    if (!terminal) {
      setStatus("idle")
    }

    abort.abort()
    const serving = stopServing?.()
    closing = (async () => {
      await beginning
      await serving
    })()

    await closing
  }
}

/** Open a separate transfer without interrupting the current one. */
export const openOtherTransfer = (): void => {
  window.open("/", "_blank", "noopener")
}
