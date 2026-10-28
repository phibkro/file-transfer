/**
 * A relay session forwards opaque ciphertext frames from a sender to one
 * recipient. Flow control is credit-based: every frame the sender pushes spends
 * one credit, and credits come back only when the recipient grants them after
 * consuming frames. That keeps relay memory bounded without any server-side
 * drain API (Durable Objects have none).
 */
import { Context, Data, Effect, Layer, Option, Ref } from "effect"

export type RelaySessionIdentifier = string

export interface RelayMeter {
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

interface SessionState {
  readonly queue: ReadonlyArray<Uint8Array>
  readonly credits: number
  readonly isClosed: boolean
  readonly framesForwarded: number
  readonly bytesForwarded: number
}

const randomIdentifier = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")

/** In-memory reference layer: the executable model every platform must match. */
export const RelayReference = Layer.effect(
  Relay,
  Effect.gen(function* () {
    const sessions = yield* Ref.make<ReadonlyMap<RelaySessionIdentifier, SessionState>>(new Map())

    const withSession = <A, E>(
      sessionIdentifier: RelaySessionIdentifier,
      step: (state: SessionState) => Effect.Effect<readonly [A, SessionState], E>,
    ): Effect.Effect<A, E | RelaySessionNotFound> =>
      Effect.gen(function* () {
        const all = yield* Ref.get(sessions)
        const state = all.get(sessionIdentifier)
        if (state === undefined) return yield* Effect.fail(new RelaySessionNotFound({ sessionIdentifier }))
        const [result, next] = yield* step(state)
        yield* Ref.update(sessions, (current) => new Map(current).set(sessionIdentifier, next))
        return result
      })

    return {
      open: ({ initialCredits }) =>
        Effect.gen(function* () {
          const sessionIdentifier = randomIdentifier()
          const state: SessionState = { queue: [], credits: Math.max(0, Math.floor(initialCredits)), isClosed: false, framesForwarded: 0, bytesForwarded: 0 }
          yield* Ref.update(sessions, (all) => new Map(all).set(sessionIdentifier, state))
          return sessionIdentifier
        }),

      push: ({ sessionIdentifier, frame }) =>
        withSession<void, NoCreditAvailable | RelaySessionClosed>(sessionIdentifier, (state) => {
          if (state.isClosed) return Effect.fail(new RelaySessionClosed({ sessionIdentifier }))
          if (state.credits < 1) return Effect.fail(new NoCreditAvailable({ sessionIdentifier }))
          return Effect.succeed([undefined, { ...state, queue: [...state.queue, frame], credits: state.credits - 1 }] as const)
        }),

      take: (sessionIdentifier) =>
        withSession(sessionIdentifier, (state) => {
          const [next, ...rest] = state.queue
          if (next === undefined) return Effect.succeed([Option.none<Uint8Array>(), state] as const)
          return Effect.succeed([
            Option.some(next),
            { ...state, queue: rest, framesForwarded: state.framesForwarded + 1, bytesForwarded: state.bytesForwarded + next.length },
          ] as const)
        }),

      grant: ({ sessionIdentifier, credits }) =>
        withSession<void, RelaySessionClosed>(sessionIdentifier, (state) => {
          if (state.isClosed) return Effect.fail(new RelaySessionClosed({ sessionIdentifier }))
          return Effect.succeed([undefined, { ...state, credits: state.credits + Math.max(0, Math.floor(credits)) }] as const)
        }),

      close: (sessionIdentifier) => withSession(sessionIdentifier, (state) => Effect.succeed([undefined, { ...state, isClosed: true }] as const)),

      meter: (sessionIdentifier) =>
        withSession(sessionIdentifier, (state) =>
          Effect.succeed([
            {
              framesForwarded: state.framesForwarded,
              bytesForwarded: state.bytesForwarded,
              framesQueued: state.queue.length,
              creditsAvailable: state.credits,
            },
            state,
          ] as const),
        ),
    }
  }),
)
