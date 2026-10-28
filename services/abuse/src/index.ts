/**
 * Notice and action (EU Digital Services Act, Article 16): receive notices,
 * acknowledge them, record decisions with reasons, and revoke rooms. A notice
 * location is stored without its URL fragment, so key material submitted by
 * mistake never reaches storage.
 */
import { declareGuarantees } from "@file-transfer/conformance/guarantee"
import { Clock, Context, Crypto, Data, Effect, Layer, Ref } from "effect"

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

export type Decision =
  | { readonly kind: "revoke"; readonly roomIdentifier: string; readonly reason: string }
  | { readonly kind: "reject"; readonly reason: string }

export class NoticeNotFound extends Data.TaggedError("NoticeNotFound")<{ readonly noticeIdentifier: NoticeIdentifier }> {}

export class NoticeIncomplete extends Data.TaggedError("NoticeIncomplete")<{ readonly missing: readonly string[] }> {}

export const abuseGuarantees = declareGuarantees([
  {
    identifier: "abuse/fragment-never-stored",
    property: "a notice location is kept without its URL fragment, so a decryption key submitted by mistake is dropped",
    strength: "port-enforced",
  },
  {
    identifier: "abuse/complete-notices-only",
    property: "a notice missing a required field is rejected, naming the missing fields",
    strength: "port-enforced",
  },
  {
    identifier: "abuse/revocation-applies",
    property: "a revoke decision revokes exactly its room; a reject decision revokes nothing",
    strength: "port-enforced",
  },
  { identifier: "abuse/unknown-notice-not-found", property: "a decision on an unknown notice is reported as not found", strength: "port-enforced" },
])

export type AbuseGuarantee = (typeof abuseGuarantees)[number]["identifier"]

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

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * In-memory reference layer: the executable model every platform must match. `faults` builds the deliberately broken
 * variants that the negative controls need; production code always uses `AbuseReference`, which has none.
 */
export const makeAbuseReference = (faults: ReadonlySet<AbuseGuarantee> = new Set()) =>
  Layer.effect(
    Abuse,
    Effect.gen(function* () {
      const notices = yield* Ref.make<ReadonlyMap<NoticeIdentifier, NoticeReceipt & { readonly decision?: Decision }>>(new Map())
      const revoked = yield* Ref.make<ReadonlySet<string>>(new Set())
      const random = yield* Crypto.Crypto
      /** Secure randomness failing is a defect of the runtime, not an outcome a caller can handle. */
      const randomIdentifier = Effect.map(Effect.orDie(random.randomBytes(16)), toHex)

      return {
        submitNotice: (notice) =>
          Effect.gen(function* () {
            const missing = (["location", "explanation", "submitterName", "submitterEmail"] as const).filter((field) => notice[field].trim() === "")

            if (missing.length > 0 && !faults.has("abuse/complete-notices-only")) {
              return yield* new NoticeIncomplete({ missing })
            }

            const receipt: NoticeReceipt = {
              noticeIdentifier: yield* randomIdentifier,
              receivedAtMilliseconds: yield* Clock.currentTimeMillis,
              storedLocation: faults.has("abuse/fragment-never-stored") ? notice.location : stripFragment(notice.location),
            }

            yield* Ref.update(notices, (all) => new Map(all).set(receipt.noticeIdentifier, receipt))

            return receipt
          }),
        decide: ({ noticeIdentifier, decision }) =>
          Effect.gen(function* () {
            const all = yield* Ref.get(notices)
            const notice = all.get(noticeIdentifier)

            if (notice === undefined) {
              if (faults.has("abuse/unknown-notice-not-found")) {
                return
              }

              return yield* new NoticeNotFound({ noticeIdentifier })
            }

            yield* Ref.set(notices, new Map(all).set(noticeIdentifier, { ...notice, decision }))

            if (decision.kind === "revoke" && !faults.has("abuse/revocation-applies")) {
              yield* Ref.update(revoked, (set) => new Set(set).add(decision.roomIdentifier))
            }
          }),
        isRevoked: (roomIdentifier) => Effect.map(Ref.get(revoked), (set) => set.has(roomIdentifier)),
      }
    }),
  )

export const AbuseReference = makeAbuseReference()
