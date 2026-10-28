// oxlint-effect-plugin ignore-file:
// reason: MVP transfer orchestration in plain TypeScript over browser Promises (Web Crypto, Blob, fetch); it moves into libraries/client as Effect services once the MVP proves out (docs/plan.md)
/**
 * The sender view (`/`): pick files, label them, open a room, show the link, and serve the parcel to the
 * recipient that accepts it (docs/protocol.md, "Order of a transfer"). MVP: one recipient, sequence number 0.
 */
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
import type { ControlMessage } from "@file-transfer/transport"
import { receiveCredit, spendCredit } from "./credits.ts"
import type { CreditBalance } from "./credits.ts"
import { openConnection } from "./connection.ts"
import type { Connection } from "./connection.ts"
import { addRecord, createRecordSet, createSchedule, markSent, peekNext, prioritise, rangesAreValid, replaceDebt } from "./ranges.ts"
import type { Schedule } from "./ranges.ts"
import { setProgress, setStatus } from "./report.ts"
import { describeFailure, element, formatSize, progressBar, replaceChildren } from "./view.ts"

const sequence = 0

interface Prepared {
  readonly sealer: ParcelSealer
  readonly contract: Contract
  readonly readRecord: RecordReader
  readonly linkSecret: Uint8Array
}

const manifestEntry = (file: File): ManifestFile => {
  const mediaType = file.type.toLowerCase()

  return { name: file.name.normalize("NFC"), size: file.size, mediaType: isValidMediaType(mediaType) ? mediaType : "" }
}

/** A failure outside the parcel library, named by a reason code like a `ParcelError`. */
class TransferError extends Error {
  override readonly name = "TransferError"
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.reason = reason
  }
}

const reasonOf = (error: unknown): string => {
  if (isParcelError(error) || error instanceof TransferError) {
    return error.reason
  }

  // A File whose bytes changed on disk after it was picked can no longer be read.
  if (error instanceof DOMException && error.name === "NotReadableError") {
    return "source-changed"
  }

  return "sender-error"
}

/** Labels every record, showing progress, and seals the contract. */
const prepare = async (files: readonly File[], onProgress: (done: number, total: number) => void): Promise<Prepared> => {
  const manifest = createManifest(files.map(manifestEntry))
  const linkSecret = createSecret()
  const sealer = await createParcelSealer({ linkSecret, sequence, manifest })
  const readRecord = recordReaderFromBlob(new Blob([...files]), sealer.recordSize)
  let labelled = 0

  const labels = await labelRecords(sealer, async (index, length) => {
    const bytes = await readRecord(index, length)
    labelled++
    onProgress(labelled, sealer.recordCount)

    return bytes
  })

  return { sealer, contract: await sealer.sealContract(labels), readRecord, linkSecret }
}

const createRoom = async (roomTokenHash: string): Promise<string> => {
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomTokenHash, maximumRecipients: 1 }),
  })

  if (response.status !== 201) {
    throw new TransferError(response.status === 429 ? "rate-limited" : "room-not-created")
  }

  const body: unknown = await response.json()
  const roomIdentifier = typeof body === "object" && body !== null && "roomIdentifier" in body ? body.roomIdentifier : undefined

  if (typeof roomIdentifier !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(roomIdentifier)) {
    throw new TransferError("room-not-created")
  }

  return roomIdentifier
}

interface SenderView {
  readonly update: (text: string) => void
  readonly progress: (done: number, total: number) => void
}

/** Serves one prepared parcel through the room until the recipient completes, declines or aborts. */
const serve = (prepared: Prepared, roomIdentifier: string, roomToken: string, view: SenderView) => {
  const { sealer, contract, readRecord } = prepared
  const digest = toHex(contract.digest)
  const everSent = createRecordSet(contract.recordCount)
  const balance: CreditBalance = { available: 0 }
  const pagesSent = new Set<number>()
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
    connection.close()
    setStatus(status, reason)

    if (status === "complete") {
      view.update("Delivered. The recipient has every file, checked against the contract.")
    } else if (status === "declined") {
      view.update("The recipient declined the files.")
    } else {
      view.update(describeFailure(reason ?? "sender-error"))
    }
  }

  const fail = (error: unknown) => {
    const reason = reasonOf(error)
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
    contract.manifestRecords.forEach((bytes, index) => connection.sendUnit({ kind: "manifestRecord", sequence, index, bytes }))
    setStatus("offering")
    view.update("The recipient is looking at the files.")
  }

  const pump = async () => {
    if (pumping) {
      return
    }

    pumping = true

    try {
      while (!finished && schedule !== undefined && balance.available > 0 && connection.isJoined()) {
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
        view.progress(everSent.count, contract.recordCount)
      }
    } catch (error) {
      fail(error)
    } finally {
      pumping = false
    }
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
          view.update("Waiting for the recipient to open the link.")
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
          view.update("The recipient disconnected. Waiting for them to come back.")
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
        view.update("Sending.")

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
        void pump()

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

        void pump()

        return
      }

      case "complete": {
        if (message.sequence === sequence) {
          setProgress(contract.recordCount, contract.recordCount)
          view.progress(contract.recordCount, contract.recordCount)
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

        return
      }

      default: {
        return
      }
    }
  }

  const connection: Connection = openConnection({
    roomIdentifier,
    role: "sender",
    roomToken,
    handlers: {
      onControl,
      onUnit: () => {},
      onState: (state) => {
        if (finished) {
          return
        }

        if (state === "reconnecting") {
          session++
          schedule = undefined
          setStatus("reconnecting")
          view.update("Connection lost. Reconnecting.")
        }
      },
    },
  })
}

export const startSender = (root: HTMLElement) => {
  const input = element("input", { type: "file", multiple: "", id: "files", class: "visually-hidden" })
  const label = element("label", { for: "files", class: "drop-zone" }, [element("strong", {}, ["Choose files"]), element("span", {}, [" or drop them here"])])
  const status = element("p", { class: "status", role: "status" })

  const section = element("section", { "aria-labelledby": "send-heading" }, [
    element("h1", { id: "send-heading" }, ["Send files"]),
    element("p", {}, ["Files are encrypted in this browser. The link holds the key; the server never sees it."]),
    input,
    label,
    status,
  ])

  replaceChildren(root, section)

  const begin = async (files: readonly File[]) => {
    if (files.length === 0) {
      return
    }

    input.disabled = true
    label.classList.add("disabled")
    const progress = progressBar("Preparing files")
    const total = files.reduce((sum, file) => sum + file.size, 0)
    section.append(
      element(
        "ul",
        { class: "file-list" },
        files.map((file) => element("li", {}, [file.name, element("span", { class: "size" }, [formatSize(file.size)])])),
      ),
      progress.node,
    )
    setStatus("labelling")

    try {
      const prepared = await prepare(files, (done, count) => {
        setProgress(done, count)
        progress.update(done, count, () => `Preparing ${formatSize(total)}: ${Math.round((done / count) * 100)}%`)
      })

      setStatus("creating-room")
      status.textContent = "Opening a room."
      const roomToken = await deriveRoomToken(prepared.linkSecret)
      const roomIdentifier = await createRoom(await hashRoomToken(roomToken))
      const link = `${location.origin}/r/${roomIdentifier}#${encodeLinkSecret(prepared.linkSecret)}`
      const linkField = element("input", { type: "text", readonly: "", id: "link", value: link, "aria-label": "Share link" })
      const copy = element("button", { type: "button" }, ["Copy link"])
      copy.addEventListener("click", () => {
        linkField.select()
        void navigator.clipboard?.writeText(link).then(() => {
          copy.textContent = "Copied"
        })
      })
      progress.update(0, prepared.contract.recordCount, () => "")
      section.insertBefore(element("div", { class: "share" }, [element("label", { for: "link" }, ["Share this link"]), linkField, copy]), status)
      serve(prepared, roomIdentifier, toHex(roomToken), {
        update: (text) => {
          status.textContent = text
        },
        progress: (done, count) => progress.update(done, count, () => `Sent ${Math.round((done / count) * 100)}% of ${formatSize(total)}`),
      })
      setProgress(0, prepared.contract.recordCount)
    } catch (error) {
      const reason = reasonOf(error)
      setStatus("failed", reason)
      status.textContent = isParcelError(error) ? `${describeFailure(reason)} ${error.message}` : describeFailure(reason)
    }
  }

  input.addEventListener("change", () => void begin([...(input.files ?? [])]))
  label.addEventListener("dragover", (event) => {
    event.preventDefault()
    label.classList.add("active")
  })
  label.addEventListener("dragleave", () => label.classList.remove("active"))
  label.addEventListener("drop", (event) => {
    event.preventDefault()
    label.classList.remove("active")

    if (!input.disabled) {
      void begin([...(event.dataTransfer?.files ?? [])])
    }
  })
}
