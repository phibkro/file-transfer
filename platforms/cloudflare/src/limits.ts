/**
 * The operator's limits for this instance (docs/decisions/0019-open-source-first.md), read from the Worker's
 * environment variables, which the operator sets in wrangler.jsonc, the Cloudflare dashboard or the deploy button.
 * Missing or invalid values fall back to the defaults, which keep a Workers Free account inside its daily budget during
 * a small burst of abuse. Pure: no I/O.
 */
import { Result, Schema } from "effect"

export interface Limits {
  /** Rooms one client address may create per hour. */
  readonly roomsPerAddressPerHour: number
  /**
   * Bytes the room relays for one room, counting every binary frame the sender sends (records, label pages, resends).
   * The server cannot see a parcel's size, which is sealed in its manifest, so this is what it enforces; the app reads
   * it from `GET /api/limits` and warns before sealing a parcel that would not fit.
   */
  readonly relayedBytesPerRoom: number
  /** The request header holding the client's address: `cf-connecting-ip` on Cloudflare, set by the proxy elsewhere. */
  readonly clientAddressHeader: string
}

export const defaultLimits: Limits = {
  // Generous, because many people can share one address (mobile carriers, universities, offices). Each room costs about
  // three storage writes, so one address at this rate uses about 7% of Workers Free's 100,000 daily writes.
  roomsPerAddressPerHour: 100,
  // 10 GB, the transfer size phase 0 set out to prove; about 8,000 billed Durable Object requests on Workers Free.
  relayedBytesPerRoom: 10_000_000_000,
  clientAddressHeader: "cf-connecting-ip",
}

/** The variables an operator may set; all are strings, as Workers environment variables are. */
export interface LimitVariables {
  readonly LIMIT_ROOMS_PER_ADDRESS_PER_HOUR?: string
  readonly LIMIT_RELAYED_BYTES_PER_ROOM?: string
  readonly CLIENT_ADDRESS_HEADER?: string
}

const PositiveInteger = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))
const decodePositiveInteger = Schema.decodeUnknownResult(PositiveInteger)

const positiveIntegerOr = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback
  }

  const decoded = decodePositiveInteger(value)

  return Result.isSuccess(decoded) ? decoded.success : fallback
}

const headerName = /^[a-z0-9-]{1,64}$/u

export const readLimits = (variables: LimitVariables): Limits => {
  const header = variables.CLIENT_ADDRESS_HEADER?.trim().toLowerCase()

  return {
    roomsPerAddressPerHour: positiveIntegerOr(variables.LIMIT_ROOMS_PER_ADDRESS_PER_HOUR, defaultLimits.roomsPerAddressPerHour),
    relayedBytesPerRoom: positiveIntegerOr(variables.LIMIT_RELAYED_BYTES_PER_ROOM, defaultLimits.relayedBytesPerRoom),
    clientAddressHeader: header !== undefined && headerName.test(header) ? header : defaultLimits.clientAddressHeader,
  }
}

/** What `GET /api/limits` tells clients: the limits a sender can act on, nothing about how addresses are read. */
export const publicLimits = (limits: Limits) => ({
  roomsPerAddressPerHour: limits.roomsPerAddressPerHour,
  relayedBytesPerRoom: limits.relayedBytesPerRoom,
})

/** Whether relaying `frameLength` more bytes after `relayedBytes` stays within `limit`. */
export const withinRelayLimit = (relayedBytes: number, frameLength: number, limit: number): boolean => relayedBytes + frameLength <= limit

/** Admission policy sent to the admission object: the operator's hourly allowance. */
export interface AdmissionRequest {
  readonly maximumRoomsPerWindow: number
  readonly windowMilliseconds: number
}

const AdmissionRequestSchema = Schema.Struct({
  maximumRoomsPerWindow: Schema.Int.check(Schema.isGreaterThan(0)),
  windowMilliseconds: Schema.Int.check(Schema.isGreaterThan(0)),
})

const decodeAdmissionRequestResult = Schema.decodeUnknownResult(AdmissionRequestSchema)

/** Decodes the admission object's request body, or undefined when it is not one. */
export const decodeAdmissionRequest = (body: unknown): AdmissionRequest | undefined => {
  const decoded = decodeAdmissionRequestResult(body)

  return Result.isSuccess(decoded) ? decoded.success : undefined
}

const decodeRefusalResult = Schema.decodeUnknownResult(Schema.Struct({ retryAfterMilliseconds: Schema.Finite }))

/** The wait a `429` from the admission object names, or `fallback` when its body says none. */
export const retryAfterMillisecondsOf = (body: unknown, fallback: number): number => {
  const decoded = decodeRefusalResult(body)

  return Result.isSuccess(decoded) ? decoded.success.retryAfterMilliseconds : fallback
}
