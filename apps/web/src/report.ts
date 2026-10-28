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
  status(): Status
  progress(): Progress
  /** The failure reason code, when the status is `failed`. */
  failure(): string | undefined
  /** SHA-256 (hex) of each received file in manifest order; empty until the recipient completes. */
  fileHashes(): Promise<readonly string[]>
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
const listeners = new Set<() => void>()
let frameRequested = false

const flush = () => {
  frameRequested = false
  document.body.dataset.progress = `${progress.done}/${progress.total}`

  for (const listener of listeners) {
    listener()
  }
}

export const setStatus = (next: Status, reason?: string) => {
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

export const setFileHashes = (compute: () => Promise<readonly string[]>) => {
  hashes = compute
}

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
  }
  document.body.dataset.status = status
}
