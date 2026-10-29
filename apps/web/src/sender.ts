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
import { setProgress, setStatus, setTotalBytes } from "./report.ts"
import { previewButton } from "./preview.ts"
import { estimatedRelayedBytes, fetchServerLimits } from "./serverLimits.ts"
import type { ServerLimits } from "./serverLimits.ts"
import { nameField } from "./rename.ts"
import { addToSelection, removeFromSelection, renameProblem } from "./selection.ts"
import { sharePanel } from "./share.ts"
import { describeFailure, element, formatSize, progressBar, replaceChildren } from "./view.ts"

const sequence = 0

interface Prepared {
  readonly sealer: ParcelSealer
  readonly contract: Contract
  readonly readRecord: RecordReader
  readonly linkSecret: Uint8Array
}

/** A chosen file and the name it is sent under, which the sender may change until the parcel is sealed. */
interface Entry {
  readonly file: File
  readonly name: string
}

const manifestEntry = ({ file, name }: Entry): ManifestFile => {
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

  return Number.isFinite(minutes) ? `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}` : "an hour"
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
const prepare = async (entries: readonly Entry[], onProgress: (done: number, total: number) => void): Promise<Prepared> => {
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

const createRoom = async (roomTokenHash: string): Promise<string> => {
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomTokenHash, maximumRecipients: 1 }),
  })

  if (response.status === 429) {
    throw new TransferError("rate-limited", `Try again in ${waitText(response.headers.get("retry-after"))}.`)
  }

  if (response.status !== 201) {
    throw new TransferError("room-not-created")
  }

  const body: unknown = await response.json()

  if (!isCreatedRoom(body) || !/^[A-Za-z0-9_-]{22}$/u.test(body.roomIdentifier)) {
    throw new TransferError("room-not-created")
  }

  return body.roomIdentifier
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

  const fail = (cause: unknown) => {
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

        break
      }

      // The one message a sender never receives.
      case "join": {
        break
      }
    }
  }

  const connection: Connection = openConnection({
    roomIdentifier,
    role: "sender",
    roomToken,
    handlers: {
      onControl,
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
          view.update("Connection lost. Reconnecting.")
        }
      },
    },
  })
}

export const startSender = (root: HTMLElement) => {
  const input = element("input", { type: "file", multiple: "", id: "files", class: "visually-hidden" })
  const pickLabel = element("strong", {}, ["Choose files"])
  const label = element("label", { for: "files", class: "drop-zone" }, [pickLabel, element("span", {}, [" or drop them here"])])
  const status = element("p", { class: "status", role: "status" })
  const list = element("ul", { class: "file-list", "aria-label": "Files to send" })
  const totals = element("p", { class: "selection-total" })
  const rejections = element("ul", { class: "rejections", role: "alert" })
  const createLink = element("button", { type: "button", class: "primary", disabled: "" }, ["Seal parcel and create link"])
  const sealNote = element("p", { class: "seal-note" }, ["Sealing locks these files and their names. To change them, you start a new parcel."])
  const sealing = element("h2", { class: "sealing-heading", hidden: "" }, ["Sealing parcel"])
  const sendOther = element("button", { type: "button", hidden: "" }, ["Send other files"])
  const limitWarning = element("p", { class: "limit-warning", role: "alert", hidden: "" })
  let selected: readonly Entry[] = []
  let sealed = false
  let serverLimits: ServerLimits | undefined

  const section = element("section", { "aria-labelledby": "send-heading" }, [
    element("h1", { id: "send-heading" }, ["Send files"]),
    element("p", {}, ["Files are encrypted in this browser. The link holds the key; the server never sees it."]),
    element("ul", { class: "promises", "aria-label": "What this site promises" }, [
      element("li", {}, [element("a", { href: "/security" }, ["End-to-end encrypted"])]),
      element("li", {}, [element("a", { href: "/privacy" }, ["No files kept on servers"])]),
      element("li", {}, [element("a", { href: "/run-your-own" }, ["Free software you can run yourself"])]),
    ]),
    input,
    label,
    rejections,
    sealing,
    list,
    totals,
    limitWarning,
    createLink,
    sealNote,
    status,
    sendOther,
  ])

  replaceChildren(root, section)

  /** Renders the list; `focusRename` puts focus back on that row's Rename button after a rename. */
  const renderSelection = (focusRename?: number) => {
    list.classList.toggle("sealed", sealed)
    list.replaceChildren(
      ...selected.map((entry, index) => {
        const name = sealed
          ? element("span", { class: "name" }, [entry.name])
          : nameField({
              name: entry.name,
              problem: (candidate) =>
                renameProblem(
                  selected.map((chosen) => chosen.name),
                  index,
                  candidate,
                ),
              onRename: (renamed) => {
                selected = selected.map((chosen, position) => (position === index ? { ...chosen, name: renamed } : chosen))
                renderSelection(index)
              },
            })

        const item = element("li", {}, [
          name,
          element("span", { class: "size" }, [formatSize(entry.file.size)]),
          previewButton(
            () => entry.file,
            () => entry.name,
          ),
        ])

        if (!sealed) {
          const remove = element("button", { type: "button", class: "remove", "aria-label": `Remove ${entry.name}` }, ["Remove"])
          remove.addEventListener("click", () => {
            selected = removeFromSelection(selected, index)
            renderSelection()
          })
          item.append(remove)
        }

        return item
      }),
    )

    if (focusRename !== undefined) {
      list.querySelectorAll<HTMLButtonElement>("button.rename")[focusRename]?.focus()
    }

    const total = selected.reduce((sum, entry) => sum + entry.file.size, 0)
    totals.textContent = selected.length === 0 ? "" : `${selected.length} ${selected.length === 1 ? "file" : "files"}, ${formatSize(total)} in total`
    pickLabel.textContent = selected.length === 0 ? "Choose files" : "Add more files"
    // The room stops a parcel that passes the instance's relay limit, so say so before sealing rather than partway.
    const tooLarge = serverLimits !== undefined && estimatedRelayedBytes(total) > serverLimits.relayedBytesPerRoom
    limitWarning.hidden = !tooLarge || sealed
    limitWarning.textContent = tooLarge
      ? `This server relays up to ${formatSize(serverLimits?.relayedBytesPerRoom ?? 0)} per parcel, and these files need about ${formatSize(estimatedRelayedBytes(total))}. Remove some files, send them in more than one parcel, or use an instance with a higher limit.`
      : ""
    createLink.disabled = sealed || selected.length === 0 || tooLarge
  }

  const add = (files: readonly File[]) => {
    if (sealed) {
      return
    }

    const change = addToSelection(
      selected,
      files.map((file) => ({ file, name: file.name.normalize("NFC") })),
    )

    selected = change.selected
    rejections.replaceChildren(...change.rejected.map((rejection) => element("li", {}, [`${rejection.name} was not added: ${rejection.reason}.`])))
    renderSelection()
  }

  const begin = async (entries: readonly Entry[]) => {
    if (entries.length === 0) {
      return
    }

    sealed = true
    input.disabled = true
    label.classList.add("disabled")
    label.hidden = true
    createLink.hidden = true
    sealNote.hidden = true
    sealing.hidden = false
    rejections.replaceChildren()
    renderSelection()
    const progress = progressBar("Sealing parcel")
    const total = entries.reduce((sum, entry) => sum + entry.file.size, 0)
    setTotalBytes(total)
    status.before(progress.node)
    setStatus("labelling")

    try {
      const prepared = await prepare(entries, (done, count) => {
        setProgress(done, count)
        progress.update(done, count, () => `Encrypting and sealing ${formatSize(total)}: ${Math.round((done / count) * 100)}%`)
      })

      sealing.textContent = "Parcel sealed"
      sendOther.hidden = false

      setStatus("creating-room")
      status.textContent = "Opening a room."
      const roomToken = await deriveRoomToken(prepared.linkSecret)
      const roomIdentifier = await createRoom(await hashRoomToken(roomToken))
      const link = `${location.origin}/r/${roomIdentifier}#${encodeLinkSecret(prepared.linkSecret)}`
      progress.update(0, prepared.contract.recordCount, () => "")
      status.before(sharePanel(link))
      serve(prepared, roomIdentifier, toHex(roomToken), {
        update: (text) => {
          status.textContent = text
        },
        progress: (done, count) => {
          progress.update(done, count, () => `Sent ${Math.round((done / count) * 100)}% of ${formatSize(total)}`)
        },
      })
      setProgress(0, prepared.contract.recordCount)
    } catch (error) {
      const reason = reasonOf(error)
      setStatus("failed", reason)
      const detail = detailOf(error)
      status.textContent = detail === undefined ? describeFailure(reason) : `${describeFailure(reason)} ${detail}`
    }
  }

  input.addEventListener("change", () => {
    add([...(input.files ?? [])])
    // Cleared so choosing the same file again still fires `change`.
    input.value = ""
  })
  createLink.addEventListener("click", () => {
    void begin(selected)
  })

  const loadLimits = async () => {
    serverLimits = await fetchServerLimits()
    renderSelection()
  }

  void loadLimits()
  // A sealed parcel cannot take more files; other files go in a new parcel with its own link, in a new tab, so this
  // one keeps serving its recipient.
  sendOther.addEventListener("click", () => {
    window.open("/", "_blank", "noopener")
  })
  label.addEventListener("dragover", (event) => {
    event.preventDefault()
    label.classList.add("active")
  })
  label.addEventListener("dragleave", () => {
    label.classList.remove("active")
  })
  label.addEventListener("drop", (event) => {
    event.preventDefault()
    label.classList.remove("active")
    add([...(event.dataTransfer?.files ?? [])])
  })
}
