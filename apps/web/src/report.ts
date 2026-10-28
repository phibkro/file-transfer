// oxlint-effect-plugin ignore-file:
// reason: the end-to-end test hook hands Playwright a Promise of file hashes; browser glue, not domain logic
/**
 * Status and progress, mirrored for end-to-end tests: `document.body.dataset.status` and `dataset.progress`
 * ("done/total"), and `window.fileTransferTest`, which on completion also gives the SHA-256 of each received file.
 * Nothing here ever holds the link secret or plaintext.
 */

export type Status =
  | "idle"
  | "labelling"
  | "creating-room"
  | "waiting-for-recipient"
  | "offering"
  | "connecting"
  | "reconnecting"
  | "waiting-for-sender"
  | "reviewing"
  | "transferring"
  | "complete"
  | "declined"
  | "failed"

export interface Progress {
  readonly done: number
  readonly total: number
}

export interface TestHook {
  readonly status: () => Status
  readonly progress: () => Progress
  /** The failure reason code, when the status is `failed`. */
  readonly failure: () => string | undefined
  /** SHA-256 (hex) of each received file in manifest order; empty until the recipient completes. */
  readonly fileHashes: () => Promise<readonly string[]>
  /** Hex of bytes `start` to `end` of received file `index`, read lazily; for files too large to hash in memory. */
  readonly fileSlice: (index: number, start: number, end: number) => Promise<string>
  /** Byte size of each received file; empty until the recipient completes. */
  readonly fileSizes: () => readonly number[]
}

declare global {
  interface Window {
    fileTransferTest?: TestHook
  }
}

let status: Status = "idle"
let progress: Progress = { done: 0, total: 0 }
let failure: string | undefined
let hashes: () => Promise<readonly string[]> = async () => []
let receivedFiles: readonly File[] = []
const listeners = new Set<() => void>()
let frameRequested = false
let totalBytes = 0
let transferStartedAt: number | undefined
let transferEndedAt: number | undefined
let reconnects = 0

const flush = () => {
  frameRequested = false
  document.body.dataset.progress = `${progress.done}/${progress.total}`

  for (const listener of listeners) {
    listener()
  }
}

export const setStatus = (next: Status, reason?: string) => {
  if (next === "transferring" && transferStartedAt === undefined) {
    transferStartedAt = performance.now()
  }

  if (next === "reconnecting" && status !== "reconnecting") {
    reconnects++
  }

  if (next === "complete" && transferEndedAt === undefined) {
    transferEndedAt = performance.now()
  }

  status = next
  failure = next === "failed" ? reason : undefined
  document.body.dataset.status = next
  flush()
}

/** Coalesces updates to one per animation frame, so per-record progress does not thrash the page. */
export const setProgress = (done: number, total: number) => {
  progress = { done, total }

  if (frameRequested) {
    return
  }

  frameRequested = true
  requestAnimationFrame(flush)
}

/** The recipient's committed files, for the byte-range and size hooks. */
export const setReceivedFiles = (files: readonly File[]) => {
  receivedFiles = files
}

const hexOf = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")

export const setFileHashes = (compute: () => Promise<readonly string[]>) => {
  hashes = compute
}

/** The plaintext bytes this transfer carries (the manifest's total size), for the completion summary. */
export const setTotalBytes = (bytes: number) => {
  totalBytes = bytes
}

export interface TransferSummary {
  readonly bytes: number
  /** From the first `transferring` status to `complete`, in seconds. */
  readonly seconds: number
  readonly reconnects: number
}

/** What the completion summary reports: sizes and timing only, never names, keys or the link. */
export const transferSummary = (): TransferSummary => ({
  bytes: totalBytes,
  seconds: transferStartedAt === undefined || transferEndedAt === undefined ? 0 : (transferEndedAt - transferStartedAt) / 1000,
  reconnects,
})

export const currentStatus = (): Status => status

/** Calls `listener` after every status or progress change. */
export const onReport = (listener: () => void) => {
  listeners.add(listener)
}

export const currentProgress = (): Progress => progress

export const installTestHook = () => {
  window.fileTransferTest = {
    status: () => status,
    progress: () => progress,
    failure: () => failure,
    fileHashes: async () => await hashes(),
    fileSlice: async (index, start, end) => {
      const file = receivedFiles[index]

      return file === undefined ? "" : hexOf(new Uint8Array(await file.slice(start, end).arrayBuffer()))
    },
    fileSizes: () => receivedFiles.map((file) => file.size),
  }
  document.body.dataset.status = status
}
