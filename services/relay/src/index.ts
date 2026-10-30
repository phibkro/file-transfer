/**
 * A relay session forwards opaque ciphertext frames from a sender to one
 * recipient. Flow control is credit-based: every frame the sender pushes spends
 * one credit, and credits come back only when the recipient grants them after
 * consuming frames. That keeps relay memory bounded without any server-side
 * drain API (Durable Objects have none).
 */
import { declareGuarantees } from "@file-transfer/conformance/guarantee"
import * as Machine from "@file-transfer/machine"
import { Context, Data, Effect, Layer, Option, Ref } from "effect"
import { SecureRandom } from "effect/crypto"

export type RelaySessionIdentifier = string

export const relayGuarantees = declareGuarantees([
  { identifier: "relay/order", property: "frames reach the recipient in the order the sender pushed them", strength: "port-enforced" },
  {
    identifier: "relay/credit-bound",
    property: "a push without an unspent credit is rejected, so queued frames never exceed granted credits",
    strength: "port-enforced",
  },
  { identifier: "relay/exact-metering", property: "the meter counts exactly the frames and bytes delivered", strength: "port-enforced" },
  { identifier: "relay/close-stops-writes", property: "a closed session rejects pushes and grants but lets the recipient drain", strength: "port-enforced" },
  { identifier: "relay/unknown-not-found", property: "an unknown session identifier is reported as not found", strength: "port-enforced" },
  {
    identifier: "relay/follows-machine",
    property: "every command in every state, the illegal ones included, does what the relay session machine's table says",
    strength: "port-enforced",
  },
])

export type RelayGuarantee = (typeof relayGuarantees)[number]["identifier"]

/** The session's life cycle. Pushes and grants run only while open; takes also run after close, to drain. */
export const relaySessionMachine = Machine.make({
  name: "RelaySession",
  states: ["Open", "Closed"],
  commands: ["openSession", "pushFrame", "grantCredits", "takeFrame", "closeSession"],
  terminal: ["Closed"],
  transitions: [
    { command: "openSession", from: [Machine.boundary], to: "Open" },
    { command: "pushFrame", from: ["Open"], to: "Open", when: "a credit is unspent" },
    { command: "grantCredits", from: ["Open"], to: "Open" },
    { command: "takeFrame", from: ["Open"], to: "Open" },
    { command: "takeFrame", from: ["Closed"], to: "Closed" },
    { command: "closeSession", from: ["Open", "Closed"], to: "Closed" },
  ],
})

export type RelaySessionState = (typeof relaySessionMachine.states)[number]

export interface RelayMeter {
  readonly state: RelaySessionState
  readonly framesForwarded: number
  readonly bytesForwarded: number
  readonly framesQueued: number
  readonly creditsAvailable: number
}

export class RelaySessionNotFound extends Data.TaggedError("RelaySessionNotFound")<{ readonly sessionIdentifier: RelaySessionIdentifier }> {}

export class NoCreditAvailable extends Data.TaggedError("NoCreditAvailable")<{ readonly sessionIdentifier: RelaySessionIdentifier }> {}

export class RelaySessionClosed extends Data.TaggedError("RelaySessionClosed")<{ readonly sessionIdentifier: RelaySessionIdentifier }> {}

export class Relay extends Context.Service<
  Relay,
  {
    readonly open: (input: { readonly initialCredits: number }) => Effect.Effect<RelaySessionIdentifier>
    /** Sender side: queue one frame, spending one credit. */
    readonly push: (input: {
      readonly sessionIdentifier: RelaySessionIdentifier
      readonly frame: Uint8Array
    }) => Effect.Effect<void, RelaySessionNotFound | NoCreditAvailable | RelaySessionClosed>
    /** Recipient side: take the next frame, in push order, if any. */
    readonly take: (sessionIdentifier: RelaySessionIdentifier) => Effect.Effect<Option.Option<Uint8Array>, RelaySessionNotFound>
    /** Recipient side: return credits to the sender after consuming frames. */
    readonly grant: (input: {
      readonly sessionIdentifier: RelaySessionIdentifier
      readonly credits: number
    }) => Effect.Effect<void, RelaySessionNotFound | RelaySessionClosed>
    readonly close: (sessionIdentifier: RelaySessionIdentifier) => Effect.Effect<void, RelaySessionNotFound>
    readonly meter: (sessionIdentifier: RelaySessionIdentifier) => Effect.Effect<RelayMeter, RelaySessionNotFound>
  }
>()("file-transfer/Relay") {}

interface SessionRecord {
  readonly state: RelaySessionState
  readonly queue: readonly Uint8Array[]
  readonly credits: number
  readonly framesForwarded: number
  readonly bytesForwarded: number
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * The in-memory reference layer: the executable model every platform must match. `faults` builds the deliberately
 * broken variants that the negative controls need; production code always uses `RelayReference`, which has none.
 */
export const makeRelayReference = (faults: ReadonlySet<RelayGuarantee> = new Set()) => {
  const isAllowed = (command: (typeof relaySessionMachine.commands)[number], state: RelaySessionState) =>
    faults.has("relay/close-stops-writes") || Machine.can(relaySessionMachine, command, state, undefined)

  return Layer.effect(
    Relay,
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyMap<RelaySessionIdentifier, SessionRecord>>(new Map())
      const random = yield* SecureRandom.SecureRandom
      /** `SecureRandom` cannot fail: a broken source of secure randomness is a defect of the runtime, not an outcome a caller can handle. */
      const randomIdentifier = Effect.map(random.randomBytes(16), toHex)

      const withSession = <A, E>(
        sessionIdentifier: RelaySessionIdentifier,
        step: (record: SessionRecord) => Effect.Effect<readonly [A, SessionRecord], E>,
      ): Effect.Effect<A, E | RelaySessionNotFound> =>
        Effect.gen(function* () {
          const all = yield* Ref.get(sessions)
          const record = all.get(sessionIdentifier)

          if (record === undefined) {
            if (!faults.has("relay/unknown-not-found")) {
              return yield* new RelaySessionNotFound({ sessionIdentifier })
            }

            const blank: SessionRecord = { state: "Open", queue: [], credits: 0, framesForwarded: 0, bytesForwarded: 0 }
            const [result] = yield* step(blank)

            return result
          }

          const [result, next] = yield* step(record)
          yield* Ref.update(sessions, (current) => new Map(current).set(sessionIdentifier, next))

          return result
        })

      return {
        open: ({ initialCredits }) =>
          Effect.gen(function* () {
            const sessionIdentifier = yield* randomIdentifier
            const record: SessionRecord = { state: "Open", queue: [], credits: Math.max(0, Math.floor(initialCredits)), framesForwarded: 0, bytesForwarded: 0 }
            yield* Ref.update(sessions, (all) => new Map(all).set(sessionIdentifier, record))

            return sessionIdentifier
          }),

        push: ({ sessionIdentifier, frame }) =>
          withSession<undefined, NoCreditAvailable | RelaySessionClosed>(sessionIdentifier, (record) => {
            if (!isAllowed("pushFrame", record.state)) {
              return Effect.fail(new RelaySessionClosed({ sessionIdentifier }))
            }

            if (record.credits < 1 && !faults.has("relay/credit-bound")) {
              return Effect.fail(new NoCreditAvailable({ sessionIdentifier }))
            }

            const queue = faults.has("relay/order") ? [frame, ...record.queue] : [...record.queue, frame]

            return Effect.succeed([undefined, { ...record, queue, credits: Math.max(0, record.credits - 1) }] as const)
          }),

        take: (sessionIdentifier) =>
          withSession(sessionIdentifier, (record) => {
            const [next, ...rest] = record.queue

            if (next === undefined) {
              return Effect.succeed([Option.none<Uint8Array>(), record] as const)
            }

            const counted = faults.has("relay/exact-metering") ? 0 : 1

            return Effect.succeed([
              Option.some(next),
              { ...record, queue: rest, framesForwarded: record.framesForwarded + counted, bytesForwarded: record.bytesForwarded + counted * next.length },
            ] as const)
          }),

        grant: ({ sessionIdentifier, credits }) =>
          withSession(sessionIdentifier, (record) => {
            if (!isAllowed("grantCredits", record.state)) {
              return Effect.fail(new RelaySessionClosed({ sessionIdentifier }))
            }

            return Effect.succeed([undefined, { ...record, credits: record.credits + Math.max(0, Math.floor(credits)) }] as const)
          }),

        close: (sessionIdentifier) =>
          withSession(sessionIdentifier, (record) => {
            const next = Machine.next(relaySessionMachine, "closeSession", record.state, undefined)

            const state = next === "Closed" && !faults.has("relay/follows-machine") ? "Closed" : record.state

            return Effect.succeed([undefined, { ...record, state }] as const)
          }),

        meter: (sessionIdentifier) =>
          withSession(sessionIdentifier, (record) =>
            Effect.succeed([
              {
                state: record.state,
                framesForwarded: record.framesForwarded,
                bytesForwarded: record.bytesForwarded,
                framesQueued: record.queue.length,
                creditsAvailable: record.credits,
              },
              record,
            ] as const),
          ),
      }
    }),
  )
}

export const RelayReference = makeRelayReference()
