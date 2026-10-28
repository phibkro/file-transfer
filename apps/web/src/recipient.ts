// oxlint-effect-plugin ignore-file:
// reason: MVP transfer orchestration in plain TypeScript over browser Promises (Web Crypto, OPFS); it moves into libraries/client as Effect services once the MVP proves out (docs/plan.md)
/**
 * The recipient view (`/r/<room>#<secret>`): open the contract, show what is on offer, and on acceptance receive,
 * verify and store every record (docs/protocol.md, "Order of a transfer"; docs/parcel.md, "Receiver rules").
 * Output stays provisional until the last record verifies; any parcel error aborts and discards it.
 */
import { bytesEqual, decodeLinkSecret, deriveRoomToken, isParcelError, labelsPerPage, openHeader, toHex } from "@file-transfer/parcel"
import type { Manifest, ParcelOpener, ParcelReceiver } from "@file-transfer/parcel"
import type { ControlMessage, Unit } from "@file-transfer/transport"
import { Result } from "effect"
import { consume, createCreditWindow, grantDue, resetCredits } from "./credits.ts"
import { openConnection } from "./connection.ts"
import type { Connection } from "./connection.ts"
import { spansFor } from "./files.ts"
import { addRecord, containsRange, createRecordSet, hasRecord, isComplete, missingRanges, rangesOf } from "./ranges.ts"
import type { RecordSet } from "./ranges.ts"
import { setFailureDetail, setFileHashes, setProgress, setReceivedFiles, setSpaceShortfall, setStatus, setTotalBytes } from "./report.ts"
import { availableStorage, openStorage } from "./storage.ts"
import type { ParcelStorage } from "./storage.ts"
import { describeFailure, element, formatSize, progressBar, replaceChildren } from "./view.ts"

const sequence = 0

/**
 * Records the recipient lets the sender have in flight: 256 of 64 KiB, 16 MiB. With 64 (4 MiB) throughput fell from
 * 10.5 MB/s at a 0 ms round trip to 5.2 MB/s at 300 ms; with 256 it held 9.7 MB/s (latency suite, 2026-10-28,
 * docs/spikes/0002-transfer-measurements.md). The relay load test still has to show 16 MiB per room is safe for
 * Durable Object memory.
 */
const creditWindow = 256

/** A dropped record is asked for again after this pause, so neighbours share one `want`. */
const wantDelayMilliseconds = 50

/** With records missing and none arriving for this long, ask for everything still missing. */
const stallMilliseconds = 5000

/** A failure outside the parcel library, named by a reason code like a `ParcelError`. */
class TransferError extends Error {
  override readonly name = "TransferError"
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.reason = reason
  }
}

const reasonOf = (cause: unknown): string => (isParcelError(cause) || cause instanceof TransferError ? cause.reason : "recipient-error")

/** Names with folders download as one flat name; the browser sanitises the rest. */
const downloadName = (name: string): string => name.split("/").join("_")

const sha256Hex = async (file: File): Promise<string> => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())))

export const startRecipient = (root: HTMLElement, roomIdentifier: string) => {
  const status = element("p", { class: "status", role: "status" })
  const section = element("section", { "aria-labelledby": "receive-heading" }, [element("h1", { id: "receive-heading" }, ["Receive files"]), status])
  replaceChildren(root, section)

  const say = (text: string) => {
    status.textContent = text
  }

  let linkSecret: Uint8Array

  try {
    linkSecret = decodeLinkSecret(location.hash)
  } catch (error) {
    const reason = reasonOf(error)
    setStatus("failed", reason)
    say(describeFailure(reason))

    return
  }

  let connection: Connection | undefined
  let opener: ParcelOpener | undefined
  let headerBytes: Uint8Array | undefined
  let manifestPlaintexts: Uint8Array[] = []
  let manifestRecords: Uint8Array[] = []
  let manifestTotal = 1
  let receiver: ParcelReceiver | undefined
  let received: RecordSet | undefined
  let fileSizes: readonly number[] = []
  let storage: ParcelStorage | undefined
  let decision: "pending" | "accepted" | "declined" = "pending"
  let finished = false
  let senderPresent = false
  let chain: Promise<void> = Promise.resolve()
  const dropped = new Set<number>()
  let wantTimer: ReturnType<typeof setTimeout> | undefined
  const credits = createCreditWindow(creditWindow)
  let lastCount = -1
  let progress: ReturnType<typeof progressBar> | undefined

  const send = (message: ControlMessage) => connection?.sendControl(message)

  /** Stops the transfer for `reason`; `fromSender` when the sender's abort carried it. */
  const stop = async (reason: string, fromSender: boolean) => {
    if (finished) {
      return
    }

    finished = true

    if (!fromSender) {
      send({ type: "abort", reason })
    }

    connection?.close()
    setStatus("failed", reason)
    say(fromSender ? `The sender stopped the transfer. ${describeFailure(reason)}` : describeFailure(reason))
    await storage?.discard()
  }

  const fail = async (cause: unknown) => {
    setFailureDetail(cause)
    await stop(reasonOf(cause), false)
  }

  const topUp = () => {
    if (received === undefined) {
      return
    }

    const due = grantDue(credits, received.size - received.count)

    if (due > 0) {
      send({ type: "credit", records: due })
    }
  }

  /** Accepts the contract on this connection: `accept`, then (when resuming) what is still missing, then credit. */
  const sendAcceptance = (resuming: boolean) => {
    if (receiver === undefined || received === undefined) {
      return
    }

    resetCredits(credits)
    dropped.clear()
    send({ type: "accept", sequence, digest: toHex(receiver.digest) })

    if (resuming) {
      send({ type: "want", sequence, ranges: missingRanges(received) })
    }

    topUp()
  }

  const finish = async () => {
    if (receiver === undefined || storage === undefined || finished) {
      return
    }

    finished = true
    const { manifest } = receiver
    const files = await storage.commit()
    send({ type: "complete", sequence })
    connection?.close()
    setReceivedFiles(files)
    setFileHashes(async () => await Promise.all(files.map(sha256Hex)))
    setStatus("complete")
    say("Every file arrived and matched what the sender promised.")
    section.append(
      element(
        "ul",
        { class: "file-list downloads" },
        files.map((file, index) => {
          const name = manifest.files[index]?.name ?? String(index)

          return element("li", {}, [
            element("a", { href: URL.createObjectURL(file), download: downloadName(name) }, [`Save ${name}`]),
            element("span", { class: "size" }, [formatSize(file.size)]),
          ])
        }),
      ),
    )
  }

  const flushWant = () => {
    wantTimer = undefined

    if (finished || dropped.size === 0) {
      return
    }

    send({ type: "want", sequence, ranges: rangesOf(dropped).slice(0, 1024) })
    dropped.clear()
  }

  const onAccept = async () => {
    if (receiver === undefined || decision !== "pending") {
      return
    }

    decision = "accepted"

    try {
      storage = await openStorage(roomIdentifier, receiver.manifest.files.length)
    } catch {
      await fail(new TransferError("storage-unavailable"))

      return
    }

    setStatus("transferring")
    progress = progressBar("Receiving files")
    section.append(progress.node)
    say("Receiving.")
    setProgress(0, receiver.recordCount)
    sendAcceptance(false)
  }

  const showOffer = (manifest: Manifest) => {
    setTotalBytes(manifest.totalSize)
    setStatus("reviewing")
    say("The sender is offering these files. Nothing is downloaded until you accept.")
    const accept = element("button", { type: "button", class: "primary" }, ["Accept"])
    const decline = element("button", { type: "button" }, ["Decline"])
    const actions = element("div", { class: "actions" }, [accept, decline])
    accept.addEventListener("click", () => {
      actions.remove()
      void onAccept()
    })
    decline.addEventListener("click", () => {
      actions.remove()
      decision = "declined"
      finished = true
      send({ type: "decline", sequence })
      connection?.close()
      setStatus("declined")
      say("You declined the files. Nothing was downloaded.")
    })
    section.append(
      element(
        "ul",
        { class: "file-list" },
        manifest.files.map((file) => element("li", {}, [file.name, element("span", { class: "size" }, [formatSize(file.size)])])),
      ),
      element("p", {}, [`${manifest.files.length} ${manifest.files.length === 1 ? "file" : "files"}, ${formatSize(manifest.totalSize)} in total`]),
      actions,
    )
    accept.focus()

    const checkSpace = async () => {
      const available = await availableStorage()

      if (available !== undefined && available < manifest.totalSize) {
        accept.disabled = true
        setSpaceShortfall(available)
        actions.before(
          element("p", { class: "space-warning", role: "alert" }, [
            `This browser can store about ${formatSize(available)} for this site, but the files need ${formatSize(manifest.totalSize)}. `,
            "Free up space, or open the link in a normal window: private windows have a small storage limit.",
          ]),
        )
      }
    }

    void checkSpace()
  }

  const onHeader = async (bytes: Uint8Array) => {
    if (receiver !== undefined) {
      // The sender offers the contract again after either side reconnects: resume under the same digest.
      if (headerBytes === undefined || !bytesEqual(bytes, headerBytes)) {
        throw new TransferError("contract-mismatch")
      }

      if (decision === "accepted") {
        sendAcceptance(true)
      }

      return
    }

    opener = await openHeader(linkSecret, bytes)
    headerBytes = bytes.slice()
    manifestPlaintexts = []
    manifestRecords = []
    manifestTotal = 1
  }

  const onManifestRecord = async (index: number, bytes: Uint8Array) => {
    if (receiver !== undefined || opener === undefined || index !== manifestPlaintexts.length) {
      return
    }

    const plaintext = await opener.openManifestRecord(index, bytes)

    if (index === 0) {
      manifestTotal = opener.manifestRecordCountFrom(plaintext)
    }

    manifestPlaintexts.push(plaintext)
    manifestRecords.push(bytes.slice())

    if (manifestPlaintexts.length < manifestTotal) {
      return
    }

    receiver = await opener.acceptContract(manifestPlaintexts, manifestRecords)
    received = createRecordSet(receiver.recordCount)
    fileSizes = receiver.manifest.files.map((file) => file.size)
    manifestPlaintexts = []
    manifestRecords = []
    showOffer(receiver.manifest)
  }

  const onLabelPage = async (page: number, bytes: Uint8Array) => {
    if (receiver === undefined || received === undefined || decision !== "accepted") {
      return
    }

    if (page >= receiver.pageCount) {
      throw new TransferError("invalid-page")
    }

    await receiver.verifyPage(page, bytes)
    const { start, end } = receiver.pageRecords(page)

    if (containsRange(received, start, end)) {
      receiver.releasePage(page)
    }
  }

  const onDataRecord = async (index: number, bytes: Uint8Array, current: boolean) => {
    if (receiver === undefined || received === undefined || storage === undefined || decision !== "accepted") {
      return
    }

    if (index >= receiver.recordCount) {
      throw new TransferError("invalid-record-index")
    }

    if (!hasRecord(received, index)) {
      let plaintext: Uint8Array<ArrayBuffer> | undefined

      try {
        plaintext = await receiver.openData(index, bytes)
      } catch (error) {
        // Receiver rule 6: a record ahead of its page is dropped and asked for again.
        if (!isParcelError(error, "label-page-missing")) {
          throw error
        }

        dropped.add(index)
        wantTimer ??= setTimeout(flushWant, wantDelayMilliseconds)
      }

      if (plaintext !== undefined) {
        const spans = spansFor(fileSizes, index * receiver.recordSize, plaintext.length)

        if (Result.isFailure(spans)) {
          throw new TransferError("invalid-record-index")
        }

        for (const span of spans.success) {
          await storage.write(span.fileIndex, span.fileOffset, plaintext.subarray(span.spanOffset, span.spanOffset + span.length))
        }

        addRecord(received, index)
        const page = Math.floor(index / labelsPerPage)
        const { start, end } = receiver.pageRecords(page)

        if (containsRange(received, start, end)) {
          receiver.releasePage(page)
        }

        setProgress(received.count, received.size)
        progress?.update(
          received.count,
          received.size,
          (done, total) => `Received ${Math.round((done / total) * 100)}% of ${formatSize(receiver?.manifest.totalSize ?? 0)}`,
        )
      }
    }

    if (current) {
      consume(credits)
      topUp()
    }

    if (isComplete(received)) {
      await finish()
    }
  }

  const handleUnit = async (unit: Unit, epoch: number) => {
    if (finished) {
      return
    }

    if (unit.sequence !== sequence) {
      throw new TransferError("unsupported-sequence")
    }

    switch (unit.kind) {
      case "header": {
        await onHeader(unit.bytes)
        break
      }

      case "manifestRecord": {
        await onManifestRecord(unit.index, unit.bytes)
        break
      }

      case "labelPage": {
        await onLabelPage(unit.index, unit.bytes)
        break
      }

      case "dataRecord": {
        await onDataRecord(unit.index, unit.bytes, epoch === connection?.epoch())
        break
      }
    }
  }

  /** Units are handled strictly in arrival order; the chain never rejects, since every failure goes to fail. */
  const onUnit = (unit: Unit, epoch: number) => {
    const previous = chain
    chain = (async () => {
      await previous

      try {
        await handleUnit(unit, epoch)
      } catch (error) {
        await fail(error)
      }
    })()
  }

  const onControl = (message: ControlMessage) => {
    if (finished) {
      return
    }

    switch (message.type) {
      case "joined": {
        senderPresent = message.senderPresent

        if (!senderPresent) {
          setStatus(decision === "accepted" ? "reconnecting" : "waiting-for-sender")
          say("Waiting for the sender.")
        } else if (decision !== "accepted") {
          setStatus("waiting-for-sender")
        }

        return
      }

      case "peer": {
        if (message.role !== "sender") {
          return
        }

        senderPresent = message.event === "joined"

        if (!senderPresent) {
          say("The sender disconnected. Waiting for them to come back.")
        }

        return
      }

      case "abort": {
        void stop(message.reason, true)

        return
      }

      case "error": {
        void fail(new TransferError(message.reason))

        break
      }

      // Messages a recipient never receives.
      case "accept":
      case "complete":
      case "credit":
      case "decline":
      case "join":
      case "want": {
        break
      }
    }
  }

  // A stalled transfer (records missing, none arriving, sender present) asks for everything still missing.
  const stallCheck = setInterval(() => {
    if (finished) {
      clearInterval(stallCheck)

      return
    }

    if (decision !== "accepted" || received === undefined || !senderPresent || connection?.isJoined() !== true) {
      return
    }

    if (received.count === lastCount && !isComplete(received)) {
      send({ type: "want", sequence, ranges: missingRanges(received) })
    }

    lastCount = received.count
  }, stallMilliseconds)

  void (async () => {
    const roomToken = toHex(await deriveRoomToken(linkSecret))
    setStatus("connecting")
    say("Connecting.")
    connection = openConnection({
      roomIdentifier,
      role: "recipient",
      roomToken,
      handlers: {
        onControl,
        onUnit,
        onState: (state) => {
          if (finished) {
            return
          }

          if (state === "reconnecting") {
            setStatus("reconnecting")
            say("Connection lost. Reconnecting.")
          } else if (state === "joined" && decision === "accepted") {
            setStatus("transferring")
            say("Receiving.")
          }
        },
      },
    })
  })()
}
