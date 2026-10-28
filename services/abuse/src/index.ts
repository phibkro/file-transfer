/**
 * Notice and action (EU Digital Services Act, Article 16): receive notices,
 * acknowledge them, record decisions with reasons, and revoke rooms. A notice
 * location is stored without its URL fragment, so key material submitted by
 * mistake never reaches storage.
 */
import { Clock, Context, Data, Effect, Layer, Ref } from "effect"

export type NoticeIdentifier = string

export interface Notice {
  /** Where the content is, usually a share link; any `#fragment` is stripped before storage. */
  readonly location: string
  readonly explanation: string
  readonly submitterName: string
  readonly submitterEmail: string
  readonly statementOfGoodFaith: true
}

export interface NoticeReceipt {
  readonly noticeIdentifier: NoticeIdentifier
  readonly receivedAtMilliseconds: number
  readonly storedLocation: string
}

export type Decision = { readonly kind: "revoke"; readonly roomIdentifier: string; readonly reason: string } | { readonly kind: "reject"; readonly reason: string }

export class NoticeNotFound extends Data.TaggedError("NoticeNotFound")<{ readonly noticeIdentifier: NoticeIdentifier }> {}
export class NoticeIncomplete extends Data.TaggedError("NoticeIncomplete")<{ readonly missing: ReadonlyArray<string> }> {}

export class Abuse extends Context.Service<
  Abuse,
  {
    readonly submitNotice: (notice: Notice) => Effect.Effect<NoticeReceipt, NoticeIncomplete>
    readonly decide: (input: { readonly noticeIdentifier: NoticeIdentifier; readonly decision: Decision }) => Effect.Effect<void, NoticeNotFound>
    readonly isRevoked: (roomIdentifier: string) => Effect.Effect<boolean>
  }
>()("file-transfer/Abuse") {}

/** Removes everything from the first `#`, which in a share link is the decryption key. */
export const stripFragment = (location: string): string => {
  const index = location.indexOf("#")
  return index === -1 ? location : location.slice(0, index)
}

const randomIdentifier = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")

/** In-memory reference layer: the executable model every platform must match. */
export const AbuseReference = Layer.effect(
  Abuse,
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyMap<NoticeIdentifier, NoticeReceipt & { readonly decision?: Decision }>>(new Map())
    const revoked = yield* Ref.make<ReadonlySet<string>>(new Set())
    return {
      submitNotice: (notice) =>
        Effect.gen(function* () {
          const missing = (["location", "explanation", "submitterName", "submitterEmail"] as const).filter((field) => notice[field].trim() === "")
          if (missing.length > 0) return yield* Effect.fail(new NoticeIncomplete({ missing }))
          const receipt: NoticeReceipt = {
            noticeIdentifier: randomIdentifier(),
            receivedAtMilliseconds: yield* Clock.currentTimeMillis,
            storedLocation: stripFragment(notice.location),
          }
          yield* Ref.update(notices, (all) => new Map(all).set(receipt.noticeIdentifier, receipt))
          return receipt
        }),
      decide: ({ noticeIdentifier, decision }) =>
        Effect.gen(function* () {
          const all = yield* Ref.get(notices)
          const notice = all.get(noticeIdentifier)
          if (notice === undefined) return yield* Effect.fail(new NoticeNotFound({ noticeIdentifier }))
          yield* Ref.set(notices, new Map(all).set(noticeIdentifier, { ...notice, decision }))
          if (decision.kind === "revoke") yield* Ref.update(revoked, (set) => new Set(set).add(decision.roomIdentifier))
        }),
      isRevoked: (roomIdentifier) => Effect.map(Ref.get(revoked), (set) => set.has(roomIdentifier)),
    }
  }),
)
