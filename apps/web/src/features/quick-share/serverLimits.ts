// oxlint-effect-plugin ignore-file:
// reason: one fetch at start-up over a browser Promise API; moves into libraries/client with the rest of the MVP orchestration (docs/plan.md)
/**
 * The limits of the instance this page came from (`GET /api/limits`, docs/decisions/0019-open-source-first.md), so the
 * sender can say before sealing that a parcel will not fit, instead of the room stopping it partway. Instances that
 * predate limits, or a failed request, mean no known limit; the room still enforces its own.
 */

export interface ServerLimits {
  readonly relayedBytesPerRoom: number
  readonly roomsPerAddressPerHour: number
}

/** Bytes a relayed parcel adds to its files: per 64 KiB record its 23-byte seal, its 32-byte label and framing. */
const overheadPerRecord = 80

/** The header, the manifest stream and label page siblings, generously. */
const fixedOverhead = 1024 * 1024

const recordSize = 64 * 1024

/** An estimate of the bytes the room relays for files totalling `totalSize`, with no resends. */
export const estimatedRelayedBytes = (totalSize: number): number =>
  totalSize + Math.max(1, Math.ceil(totalSize / recordSize)) * overheadPerRecord + fixedOverhead

const isLimits = (body: unknown): body is ServerLimits =>
  typeof body === "object" &&
  body !== null &&
  "relayedBytesPerRoom" in body &&
  Number.isSafeInteger(body.relayedBytesPerRoom) &&
  "roomsPerAddressPerHour" in body &&
  Number.isSafeInteger(body.roomsPerAddressPerHour)

/** The instance's limits, or undefined when it does not say. */
export const fetchServerLimits = async (): Promise<ServerLimits | undefined> => {
  try {
    const response = await fetch("/api/limits", { cache: "no-store" })
    const body: unknown = response.ok ? await response.json() : undefined

    return isLimits(body) ? body : undefined
  } catch {
    return undefined
  }
}
