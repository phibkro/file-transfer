// oxlint-effect-plugin ignore-file:
// reason: the wire-format core is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/** Every failure the format reports. Callers branch on `reason`, never on the message. */

export type FormatErrorReason =
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

export class FormatError extends Error {
  override readonly name = "FormatError"
  readonly reason: FormatErrorReason

  constructor(reason: FormatErrorReason, message: string) {
    super(message)
    this.reason = reason
  }
}

export const isFormatError = (value: unknown, reason?: FormatErrorReason): value is FormatError =>
  value instanceof FormatError && (reason === undefined || value.reason === reason)
