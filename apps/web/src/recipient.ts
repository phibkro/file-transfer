// oxlint-effect-plugin ignore-file:
// reason: MVP transfer orchestration in plain TypeScript over browser Promises (Web Crypto, OPFS); it moves into libraries/client as Effect services once the MVP proves out (docs/plan.md)
/**
 * The recipient view (`/r/<room>#<secret>`): open the contract, show what is on offer, and on acceptance receive,
 * verify and store every record (docs/protocol.md, "Order of a transfer"; docs/parcel.md, "Receiver rules").
 * Output stays provisional until the last record verifies; any parcel error aborts and discards it.
 */
import { bytesEqual, decodeLinkSecret, deriveRoomToken, isParcelError, labelsPerPage, openHeader, toHex } from "@file-transfer/parcel"
import type { Manifest, ParcelOpener, ParcelReceiver } from "@file-transfer/parcel"
import type { ControlMessage, Unit } from "@file-transfer/transport/protocol"
import { linkFragment } from "./address.ts"
import { consume, createCreditWindow, grantDue, resetCredits } from "./credits.ts"
import { openConnection } from "./connection.ts"
import type { Connection, PathName } from "./connection.ts"
import { directOption } from "./directSettings.ts"
import { spansFor } from "./files.ts"
import { addRecord, containsRange, createRecordSet, hasRecord, isComplete, missingRanges, rangesOf } from "./ranges.ts"
import type { RecordSet } from "./ranges.ts"
import {
  setFailureDetail,
  setFileHashes,
  setPath,
  setProgress,
  setReceivedFiles,
  setSpaceShortfall,
  setStatus,
  setTotalBytes,
  transferSummary,
} from "./report.ts"
import { setUnsavedFiles } from "./leaveGuard.ts"
import { offerRemoval } from "./storagePanel.ts"
import { previewButton } from "./preview.ts"
import { isAccepted, isSettled, nextPhase } from "./recipientPhase.ts"
import type { RecipientCommand, RecipientPhase } from "./recipientPhase.ts"
import { nameField } from "./rename.ts"
import { saveAllControl } from "./saveAll.ts"
import { renameProblem } from "./selection.ts"
import { availableStorage, openStorage } from "./storage.ts"
import type { ParcelStorage } from "./storage.ts"
import { describeFailure, element, formatSize, progressBar, replaceChildren } from "./view.ts"

const sequence = 0

/** Offers at least this large ask for confirmation on mobile data; smaller ones would only add noise. */
const mobileDataWarningBytes = 10_000_000

interface NetworkInformation {
  readonly type?: string
  readonly saveData?: boolean
}

/**
 * Whether the browser reports a cellular connection or Data Saver mode. Only Chromium-based browsers report this
 * (Chrome on Android: `type`; Chromium: `saveData`); Safari and desktop Firefox never warn (MDN browser-compat-data,
 * api/NetworkInformation.json).
 */
const onMobileData = (): boolean => {
  if (!("connection" in navigator)) {
    return false
  }

  // SAFETY: the `in` check above found the property; the DOM types this project builds with do not declare it.
  const connection = navigator.connection as NetworkInformation | undefined

  return connection?.type === "cellular" || connection?.saveData === true
}

/** How long a recipient that has completed stays connected to repeat `complete` to a reconnecting sender. */
const completionLingerMilliseconds = 120_000

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
    linkSecret = decodeLinkSecret(linkFragment())
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
  // The life cycle (recipientPhase.ts). Once Completed, the recipient stays connected for a while, repeating `complete`
  // whenever the sender rejoins or offers the contract again, because a `complete` sent while the sender reconnects is
  // lost.
  let phase: RecipientPhase = "Opening"
  let senderPresent = false
  // Accept and Decline, while the offer is on screen; removed whenever the recipient leaves Reviewing.
  let offerActions: HTMLElement | undefined
  let chain: Promise<void> = Promise.resolve()
  const dropped = new Set<number>()
  let wantTimer: ReturnType<typeof setTimeout> | undefined
  const credits = createCreditWindow(creditWindow)
  let lastCount = -1
  let progress: ReturnType<typeof progressBar> | undefined
  // The names files are saved under: the manifest's until the recipient renames one. Only this browser sees them; the
  // contract, the sender and the files' contents are unaffected.
  let saveNames: string[] = []
  const fileList = element("ul", { class: "file-list" })
  // Set once every file is committed; the files' download links are created once and reused across renders.
  let savable: { name: string; readonly file: File; readonly url: string }[] | undefined
  let filesRemoved = false
  // The Save links on the page now, by file; Save all activates these where the browser has no folder picker.
  const saveLinks: HTMLAnchorElement[] = []

  /** Renders the file list; `focusRename` puts focus back on that row's Rename button after a rename. */
  const renderFiles = (focusRename?: number) => {
    const sizes = fileSizes
    fileList.replaceChildren(
      ...saveNames.map((name, index) => {
        const item = element("li", {}, [
          filesRemoved
            ? element("span", { class: "name" }, [name])
            : nameField({
                name,
                problem: (candidate) => renameProblem(saveNames, index, candidate),
                onRename: (renamed) => {
                  saveNames = saveNames.map((current, position) => (position === index ? renamed : current))
                  const entry = savable?.[index]

                  if (entry !== undefined) {
                    entry.name = renamed
                  }

                  renderFiles(index)
                },
              }),
          element("span", { class: "size" }, [formatSize(sizes[index] ?? 0)]),
        ])

        const entry = savable?.[index]

        if (entry !== undefined && !filesRemoved) {
          const link = element("a", { href: entry.url, download: downloadName(name), class: "save", "aria-label": `Save ${name}` }, ["Save"])
          link.addEventListener("click", () => {
            setUnsavedFiles(false)
          })
          saveLinks[index] = link
          item.append(
            link,
            previewButton(
              () => entry.file,
              () => entry.name,
            ),
          )
        }

        return item
      }),
    )

    if (focusRename !== undefined) {
      fileList.querySelectorAll<HTMLButtonElement>("button.rename")[focusRename]?.focus()
    }
  }

  const send = (message: ControlMessage) => connection?.sendControl(message)

  /** Moves to the phase `command` leads to; false, and no move, when the table rejects `command` in this phase. */
  const move = (command: RecipientCommand): boolean => {
    const next = nextPhase(phase, command)

    if (next === undefined) {
      return false
    }

    phase = next

    if (phase !== "Reviewing") {
      offerActions?.remove()
      offerActions = undefined
    }

    return true
  }

  /**
   * Stops the transfer for `reason`: tells the sender (unless its abort carried the reason), discards what was stored
   * and releases the storage lock. `command` is `commitFailed` when saving the files failed, and `fail` otherwise.
   */
  const stop = async (reason: string, fromSender: boolean, command: "fail" | "commitFailed" = "fail") => {
    if (!move(command)) {
      return
    }

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
    await stop(reasonOf(cause), false, phase === "Committing" ? "commitFailed" : "fail")
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

  const announceCompletion = () => {
    send({ type: "complete", sequence, path: transferSummary().direct ? "direct" : "relay" })
  }

  const finish = async () => {
    if (receiver === undefined || storage === undefined || !move("lastRecordStored")) {
      return
    }

    const { manifest } = receiver
    // A failure here reaches fail through the unit chain, in Committing, so it leads to Failed (commitFailed).
    const files = await storage.commit()

    if (!move("commitSucceeded")) {
      return
    }

    announceCompletion()
    setTimeout(() => {
      connection?.close()
    }, completionLingerMilliseconds)
    setReceivedFiles(files)
    setFileHashes(async () => await Promise.all(files.map(sha256Hex)))
    setStatus("complete")
    say("Every file arrived and matched what the sender promised.")

    savable = files.map((file, index) => ({ name: saveNames[index] ?? manifest.files[index]?.name ?? String(index), file, url: URL.createObjectURL(file) }))
    fileList.classList.add("downloads")
    renderFiles()

    // Received files are decrypted and live only in this browser until saved: ask before leaving until then.
    setUnsavedFiles(true)

    if (savable.length > 1) {
      const entries = savable
      section.append(
        // Read when pressed, so renames made after this point count.
        saveAllControl(
          () =>
            entries.flatMap((entry, index) => {
              const link = saveLinks[index]

              return link === undefined ? [] : [{ name: entry.name, file: entry.file, link }]
            }),
          () => {
            setUnsavedFiles(false)
          },
        ),
      )
    }

    const remove = element("button", { type: "button" }, ["Remove from this browser"])

    const removeFiles = async () => {
      remove.disabled = true

      for (const { url } of savable ?? []) {
        URL.revokeObjectURL(url)
      }

      filesRemoved = true
      renderFiles()
      await storage?.remove()
      setUnsavedFiles(false)
      offerRemoval(undefined)
      say("The files were removed from this browser. Copies you saved are not affected.")
    }

    remove.addEventListener("click", () => {
      void removeFiles()
    })
    // The storage panel's Clear removes them the same way.
    offerRemoval(removeFiles)
    section.append(
      element("div", { class: "remove-files" }, [
        remove,
        element("p", { class: "remove-files-note" }, ["Received files stay in this browser only until you leave the page."]),
      ]),
    )
  }

  const flushWant = () => {
    wantTimer = undefined

    if (phase !== "Receiving" || dropped.size === 0) {
      return
    }

    send({ type: "want", sequence, ranges: rangesOf(dropped).slice(0, 1024) })
    dropped.clear()
  }

  const onAccept = async () => {
    if (receiver === undefined || !move("accept")) {
      return
    }

    let opened: ParcelStorage

    try {
      opened = await openStorage(roomIdentifier, receiver.manifest.files.length)
    } catch {
      await fail(new TransferError("storage-unavailable"))

      return
    }

    // The transfer may have failed while storage opened (an abort from the sender, say): give the storage back.
    if (!move("storageOpened")) {
      await opened.discard()

      return
    }

    storage = opened
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
    offerActions = actions
    accept.addEventListener("click", () => {
      void onAccept()
    })
    decline.addEventListener("click", () => {
      if (!move("decline")) {
        return
      }

      send({ type: "decline", sequence })
      connection?.close()
      setStatus("declined")
      say("You declined the files. Nothing was downloaded.")
    })
    saveNames = manifest.files.map((file) => file.name)
    fileSizes = manifest.files.map((file) => file.size)
    renderFiles()
    section.append(
      fileList,
      element("p", {}, [`${manifest.files.length} ${manifest.files.length === 1 ? "file" : "files"}, ${formatSize(manifest.totalSize)} in total`]),
      element("p", { class: "rename-note" }, ["Renaming changes only the name a file is saved under in this browser. The sender's copies keep their names."]),
      actions,
    )
    accept.focus()

    if (onMobileData() && manifest.totalSize >= mobileDataWarningBytes) {
      accept.textContent = `Accept and download ${formatSize(manifest.totalSize)} on mobile data`
      actions.before(
        element("p", { class: "mobile-data-warning", role: "note" }, [
          `You seem to be on mobile data or in Data Saver mode. Accepting downloads ${formatSize(manifest.totalSize)}.`,
        ]),
      )
    }

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

      if (isAccepted(phase)) {
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

    if (move("contractOpened")) {
      showOffer(receiver.manifest)
    }
  }

  const onLabelPage = async (page: number, bytes: Uint8Array) => {
    if (receiver === undefined || received === undefined || !isAccepted(phase)) {
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
    if (receiver === undefined || received === undefined || storage === undefined || phase !== "Receiving") {
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

        if (!spans.ok) {
          throw new TransferError("invalid-record-index")
        }

        for (const span of spans.spans) {
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
    if (phase === "Completed") {
      // The sender offering the contract again means it reconnected without hearing `complete`.
      if (unit.kind === "header") {
        announceCompletion()
      }

      return
    }

    if (isSettled(phase)) {
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
    if (phase === "Completed") {
      const senderJoined =
        (message.type === "joined" && message.senderPresent) || (message.type === "peer" && message.role === "sender" && message.event === "joined")

      // The sender leaving says nothing about whether it heard `complete`: its socket may have dropped with `complete`
      // in flight. So the recipient stays for its whole linger and repeats `complete` whenever the sender comes back
      // (docs/spikes/0006, R4).
      if (senderJoined) {
        announceCompletion()
      }

      return
    }

    if (isSettled(phase)) {
      return
    }

    switch (message.type) {
      case "joined": {
        senderPresent = message.senderPresent

        if (!senderPresent) {
          setStatus(isAccepted(phase) ? "reconnecting" : "waiting-for-sender")
          say("Waiting for the sender.")
        } else if (!isAccepted(phase)) {
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
      case "signal":
      case "want": {
        break
      }
    }
  }

  // A direct path that closes mid-transfer may have dropped records in flight, and the sender's credits with them:
  // accept again on the relay, as after a reconnect, so both sides start a fresh session from what is missing.
  const onPath = (path: PathName) => {
    setPath(path)

    if (path === "relay" && phase === "Receiving" && senderPresent) {
      sendAcceptance(true)
    }
  }

  // A stalled transfer (records missing, none arriving, sender present) asks for everything still missing.
  const stallCheck = setInterval(() => {
    if (isSettled(phase)) {
      clearInterval(stallCheck)

      return
    }

    if (phase !== "Receiving" || received === undefined || !senderPresent || connection?.isJoined() !== true) {
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
    const direct = await directOption()
    connection = openConnection({
      roomIdentifier,
      role: "recipient",
      roomToken,
      direct,
      handlers: {
        onPath,
        onControl,
        onUnit,
        onState: (state) => {
          if (isSettled(phase)) {
            return
          }

          if (state === "reconnecting") {
            setStatus("reconnecting")
            say("Connection lost. Reconnecting.")
          } else if (state === "joined" && isAccepted(phase)) {
            setStatus("transferring")
            say("Receiving.")
          }
        },
      },
    })
  })()
}
