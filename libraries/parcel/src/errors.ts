// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/** Every failure the parcel library reports. Callers branch on `reason`, never on the message. */

export type ParcelErrorReason =
  | "invalid-argument"
  | "invalid-secret"
  | "invalid-header"
  | "unsupported-version"
  | "invalid-record-size"
  | "key-commitment-mismatch"
  | "authentication-failed"
  | "invalid-manifest"
  | "invalid-trailer"
  | "size-mismatch"
  | "truncated"
  | "trailing-data"
  | "record-count-mismatch"
  | "root-hash-mismatch"

export class ParcelError extends Error {
  override readonly name = "ParcelError"
  readonly reason: ParcelErrorReason

  constructor(reason: ParcelErrorReason, message: string) {
    super(message)
    this.reason = reason
  }
}

export const isParcelError = (value: unknown, reason?: ParcelErrorReason): value is ParcelError =>
  value instanceof ParcelError && (reason === undefined || value.reason === reason)
