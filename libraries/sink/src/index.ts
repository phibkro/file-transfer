/**
 * Where verified plaintext goes on the recipient: a save tier chosen per
 * browser, plus the resume bitmap. Tiers follow SkySend's design (service
 * worker stream, File System Access, OPFS then save, Blob as last resort) and
 * are implemented in milestone M2 after the M0 save-tier test.
 */
import type { Effect } from "effect"
import { Data } from "effect"

export type SaveTier = "file-system-access" | "service-worker-stream" | "origin-private-file-system" | "blob"

export class SinkFailed extends Data.TaggedError("SinkFailed")<{ readonly tier: SaveTier; readonly reason: string }> {}

export interface Sink {
  readonly tier: SaveTier
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, SinkFailed>
  readonly finish: Effect.Effect<void, SinkFailed>
  readonly abort: (reason: string) => Effect.Effect<void>
}

/** Records which data records have been verified and written, for resume. */
export interface ResumeBitmap {
  readonly markWritten: (recordIndex: number) => Effect.Effect<void>
  /** First record index not yet written; resume asks the sender from here. */
  readonly firstMissing: Effect.Effect<number>
}
