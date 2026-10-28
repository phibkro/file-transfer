// oxlint-effect-plugin ignore-file:
// reason: the wire-format core is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/** Encrypted object format v1. Specification: docs/format.md. MIT licensed. */
export * from "./bytes.ts"
export * from "./constants.ts"
export * from "./errors.ts"
export * from "./header.ts"
export * from "./keys.ts"
export * from "./manifest.ts"
export * from "./merkle.ts"
export * from "./streams.ts"
export * from "./transfer.ts"

/** Constant-time comparison for equal-length hex strings (room-token hashes). */
export const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}
