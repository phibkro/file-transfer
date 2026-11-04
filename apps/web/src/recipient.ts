// oxlint-effect-plugin ignore-file:
// reason: MVP transfer orchestration in plain TypeScript over browser Promises (Web Crypto, OPFS); it moves into libraries/client as Effect services once the MVP proves out (docs/plan.md)
/**
 * The recipient session: open the contract, publish the offer, and on acceptance receive,
 * verify and store every record (docs/protocol.md, "Order of a transfer"; docs/parcel.md, "Receiver rules").
 * Output stays provisional until the last record verifies; any parcel error aborts and discards it.
 */
import { bytesEqual, decodeLinkSecret, deriveRoomToken, isParcelError, labelsPerPage, openHeader, toHex } from "@file-transfer/parcel"
import type { Manifest, ParcelOpener, ParcelReceiver } from "@file-transfer/parcel"
import type { ControlMessage, Unit } from "@file-transfer/transport/protocol"
import { consume, createCreditWindow, grantDue, resetCredits } from "./credits.ts"
import { openConnection } from "./connection.ts"
import type { Connection, PathName } from "./connection.ts"
import { directOption } from "./directSettings.ts"
import { spansFor } from "./files.ts"
import { addRecord, containsRange, createRecordSet, hasRecord, isComplete, missingRanges, rangesOf } from "./ranges.ts"
import type { RecordSet } from "./ranges.ts"
import type { Status, Progress, TransferSummary } from "./report.ts"
import { isAccepted, isSettled, nextPhase } from "./recipientPhase.ts"
import type { RecipientCommand, RecipientPhase } from "./recipientPhase.ts"
import { renameProblem } from "./selection.ts"
import { availableStorage, openStorage } from "./storage.ts"
import type { ParcelStorage } from "./storage.ts"
import { describeFailure } from "./view.ts"

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

export interface RecipientSnapshot {
  readonly phase: RecipientPhase
  readonly status: Status
  readonly statusText: string
  readonly files: readonly { readonly name: string; readonly size: number; readonly file?: File; readonly url?: string }[]
  readonly totalBytes: number
  readonly mobileWarning: boolean
  readonly spaceShortfall: number | undefined
  readonly spaceChecking: boolean
  readonly progress: Progress
  readonly filesRemoved: boolean
  readonly unsavedFiles: boolean
  readonly failure: string | undefined
  readonly failureDetail: string | undefined
  readonly path: PathName
  readonly summary: TransferSummary
}

export const createRecipientSession = (roomIdentifier: string, fragment: string) => {
  let closed = false
  let status: Status = "idle"
  let statusText = ""
  let totalBytes = 0
  let mobileWarning = false
  let spaceShortfall: number | undefined
  let spaceChecking = false
  let progress: Progress = { done: 0, total: 0 }
  let failure: string | undefined
  let failureDetail: string | undefined
  let path: PathName = "relay"
  let wentDirect = false
  let startedAt: number | undefined
  let endedAt: number | undefined
  let directOpenedAt: number | undefined
  let directDrops = 0
  let reconnects = 0
  const listeners = new Set<(snapshot: RecipientSnapshot) => void>()

  const transferSummary = (): TransferSummary => ({
    bytes: totalBytes,
    seconds: startedAt === undefined || endedAt === undefined ? 0 : (endedAt - startedAt) / 1000,
    reconnects,
    direct: wentDirect,
    secondsToDirect: directOpenedAt === undefined || startedAt === undefined ? undefined : Math.max(0, (directOpenedAt - startedAt) / 1000),
    directDrops,
  })

  const currentSnapshot = (): RecipientSnapshot => ({
    phase,
    status,
    statusText,
    files: saveNames.map((name, index) => {
      const size = fileSizes[index] ?? 0
      const entry = savable?.[index]

      return entry === undefined || filesRemoved ? { name, size } : { name, size, file: entry.file, url: entry.url }
    }),
    totalBytes,
    mobileWarning,
    spaceShortfall,
    spaceChecking,
    progress,
    filesRemoved,
    unsavedFiles,
    failure,
    failureDetail,
    path,
    summary: transferSummary(),
  })

  const publish = () => {
    if (!closed) {
      for (const listener of listeners) {
        listener(currentSnapshot())
      }
    }
  }

  const say = (text: string) => {
    statusText = text
    publish()
  }

  const setStatus = (next: Status, reason?: string) => {
    if (next === "transferring" && startedAt === undefined) {
      startedAt = performance.now()
    }

    if (next === "reconnecting" && status !== next) {
      reconnects++
    }

    if (next === "complete" && endedAt === undefined) {
      endedAt = performance.now()
    }

    status = next
    failure = next === "failed" ? reason : undefined
    publish()
  }

  const setProgress = (done: number, total: number) => {
    progress = { done, total }
    publish()
  }

  const setPath = (next: PathName) => {
    if (next === "direct" && directOpenedAt === undefined) {
      directOpenedAt = performance.now()
    }

    if (next === "relay" && path === "direct" && status === "transferring") {
      directDrops++
    }

    path = next
    wentDirect ||= next === "direct"
    publish()
  }

  const setFailureDetail = (cause: unknown) => {
    failureDetail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  }

  let linkSecret: Uint8Array

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
  let chain: Promise<void> = Promise.resolve()
  let cleanup: Promise<void> | undefined
  const dropped = new Set<number>()
  let wantTimer: ReturnType<typeof setTimeout> | undefined
  const credits = createCreditWindow(creditWindow)
  let lastCount = -1
  // The names files are saved under: the manifest's until the recipient renames one. Only this browser sees them; the
  // contract, the sender and the files' contents are unaffected.
  let saveNames: string[] = []
  let savable: { name: string; readonly file: File; readonly url: string }[] | undefined
  let filesRemoved = false
  let unsavedFiles = false
  const abortOpening = new AbortController()
  let opening: Promise<void> | undefined
  let lingerTimer: ReturnType<typeof setTimeout> | undefined

  const send = (message: ControlMessage) => {
    if (!closed) {
      connection?.sendControl(message)
    }
  }

  /** Moves to the phase `command` leads to; false, and no move, when the table rejects `command` in this phase. */
  const move = (command: RecipientCommand): boolean => {
    const next = nextPhase(phase, command)

    if (next === undefined) {
      return false
    }

    phase = next

    publish()

    return true
  }

  /**
   * Stops the transfer for `reason`: tells the sender (unless its abort carried the reason), discards what was stored
   * and releases the storage lock. `command` is `commitFailed` when saving the files failed, and `fail` otherwise.
   */
  const stop = async (reason: string, fromSender: boolean, command: "fail" | "commitFailed" = "fail", fromChain = false) => {
    if (!move(command)) {
      return
    }

    abortOpening.abort()

    if (!fromSender) {
      send({ type: "abort", reason })
    }

    connection?.close()
    setStatus("failed", reason)
    say(fromSender ? `The sender stopped the transfer. ${describeFailure(reason)}` : describeFailure(reason))
    cleanup = (async () => {
      if (!fromChain) {
        await chain
      }

      const held = storage
      storage = undefined
      await held?.discard()
    })()
    await cleanup
  }

  const fail = async (cause: unknown, fromChain = false) => {
    if (closed) {
      return
    }

    setFailureDetail(cause)
    await stop(reasonOf(cause), false, phase === "Committing" ? "commitFailed" : "fail", fromChain)
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
    if (closed || receiver === undefined || storage === undefined || !move("lastRecordStored")) {
      return
    }

    const { manifest } = receiver
    // A failure here reaches fail through the unit chain, in Committing, so it leads to Failed (commitFailed).
    const files = await storage.commit()

    if (closed || !move("commitSucceeded")) {
      return
    }

    announceCompletion()
    lingerTimer = setTimeout(() => {
      connection?.close()
    }, completionLingerMilliseconds)
    setStatus("complete")
    say("Every file arrived and matched what the sender promised.")
    unsavedFiles = true
    savable = files.map((file, index) => ({ name: saveNames[index] ?? manifest.files[index]?.name ?? String(index), file, url: URL.createObjectURL(file) }))
    publish()
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
    if (closed || spaceChecking || spaceShortfall !== undefined || receiver === undefined || !move("accept")) {
      return
    }

    let opened: ParcelStorage

    try {
      opened = await openStorage(roomIdentifier, receiver.manifest.files.length, abortOpening.signal)
    } catch {
      if (closed || phase !== "OpeningStorage") {
        return
      }

      await fail(new TransferError("storage-unavailable"))

      return
    }

    // The transfer may have failed while storage opened (an abort from the sender, say): give the storage back.
    if (closed || !move("storageOpened")) {
      await opened.discard()

      return
    }

    storage = opened
    setStatus("transferring")
    say("Receiving.")
    setProgress(0, receiver.recordCount)
    sendAcceptance(false)
  }

  const showOffer = (manifest: Manifest) => {
    totalBytes = manifest.totalSize
    saveNames = manifest.files.map((file) => file.name)
    fileSizes = manifest.files.map((file) => file.size)
    mobileWarning = onMobileData() && manifest.totalSize >= mobileDataWarningBytes
    spaceChecking = true
    setStatus("reviewing")
    say("The sender is offering these files. Nothing is downloaded until you accept.")
    void (async () => {
      const available = await availableStorage()

      if (closed || phase !== "Reviewing") {
        return
      }

      spaceChecking = false

      if (available !== undefined && available < manifest.totalSize) {
        spaceShortfall = available
      }

      publish()
    })()
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

      if (closed || phase !== "Receiving") {
        return
      }

      if (plaintext !== undefined) {
        const spans = spansFor(fileSizes, index * receiver.recordSize, plaintext.length)

        if (!spans.ok) {
          throw new TransferError("invalid-record-index")
        }

        for (const span of spans.spans) {
          await storage.write(span.fileIndex, span.fileOffset, plaintext.subarray(span.spanOffset, span.spanOffset + span.length))

          if (closed || phase !== "Receiving") {
            return
          }
        }

        addRecord(received, index)
        const page = Math.floor(index / labelsPerPage)
        const { start, end } = receiver.pageRecords(page)

        if (containsRange(received, start, end)) {
          receiver.releasePage(page)
        }

        setProgress(received.count, received.size)
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
    if (closed) {
      return
    }

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
        await fail(error, true)
      }
    })()
  }

  const onControl = (message: ControlMessage) => {
    if (closed) {
      return
    }

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
  const onPath = (nextPath: PathName) => {
    if (closed) {
      return
    }

    setPath(nextPath)

    if (nextPath === "relay" && phase === "Receiving" && senderPresent) {
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
    try {
      try {
        linkSecret = decodeLinkSecret(fragment)
      } catch (error) {
        await fail(error)

        return
      }

      const roomToken = toHex(await deriveRoomToken(linkSecret))

      if (closed) {
        return
      }

      setStatus("connecting")
      say("Connecting.")
      const direct = await directOption()

      if (closed) {
        return
      }

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
            if (closed || isSettled(phase)) {
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
    } catch (error) {
      if (!closed) {
        await fail(error)
      }
    }
  })()

  let removal: Promise<void> | undefined

  const removeAll = async (): Promise<void> => {
    if (removal !== undefined) {
      await removal

      return
    }

    if (closed || phase !== "Completed") {
      return
    }

    filesRemoved = true
    unsavedFiles = false

    for (const entry of savable ?? []) {
      URL.revokeObjectURL(entry.url)
    }

    savable = undefined
    const held = storage
    storage = undefined
    removal = (async () => {
      await held?.remove()
      say("The files were removed from this browser. Copies you saved are not affected.")
    })()

    await removal
  }

  let receipt: Promise<void> | undefined

  const dispose = async (): Promise<void> => {
    if (receipt !== undefined) {
      await receipt

      return
    }

    closed = true
    abortOpening.abort()
    listeners.clear()
    connection?.close()
    clearInterval(stallCheck)
    clearTimeout(wantTimer)
    clearTimeout(lingerTimer)
    receipt = (async () => {
      await chain
      await cleanup
      await opening
      await removal

      for (const entry of savable ?? []) {
        URL.revokeObjectURL(entry.url)
      }

      savable = undefined

      if (storage !== undefined) {
        await (phase === "Completed" ? storage.remove() : storage.discard())
        storage = undefined
      }
    })()

    await receipt
  }

  return {
    currentSnapshot,
    subscribe: (listener: (snapshot: RecipientSnapshot) => void) => {
      if (closed) {
        return () => undefined
      }

      listeners.add(listener)
      listener(currentSnapshot())

      return () => {
        listeners.delete(listener)
      }
    },
    accept: async () => {
      if (closed || phase !== "Reviewing" || spaceChecking || spaceShortfall !== undefined) {
        return
      }

      opening ??= onAccept()

      await opening
    },
    decline: () => {
      if (closed || !move("decline")) {
        return
      }

      send({ type: "decline", sequence })
      connection?.close()
      setStatus("declined")
      say("You declined the files. Nothing was downloaded.")
    },
    rename: (index: number, name: string) => {
      if (closed || filesRemoved || index < 0 || index >= saveNames.length || renameProblem(saveNames, index, name) !== undefined) {
        return
      }

      saveNames[index] = name

      if (savable?.[index] !== undefined) {
        savable[index].name = name
      }

      publish()
    },
    markSaved: () => {
      if (closed) {
        return
      }

      unsavedFiles = false
      publish()
    },
    removeAll,
    dispose,
  }
}

export type RecipientSession = ReturnType<typeof createRecipientSession>
