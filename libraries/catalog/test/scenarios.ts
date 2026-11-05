import { Data, Effect, Result } from "effect"
import { Catalog, deriveMyFiles } from "../src/index.ts"
import type { CatalogError, LibraryEntry, LibrarySnapshot } from "../src/index.ts"

export class CatalogScenarioFailure extends Data.TaggedError("CatalogScenarioFailure")<{ readonly message: string }> {}

const check = (condition: boolean, message: string) => (condition ? Effect.void : Effect.fail(new CatalogScenarioFailure({ message })))

const firstFile = (snapshot: LibrarySnapshot) =>
  Effect.fromResult(
    snapshot.files[0] === undefined ? Result.fail(new CatalogScenarioFailure({ message: "Expected indexed file" })) : Result.succeed(snapshot.files[0]),
  )

const firstCollection = (snapshot: LibrarySnapshot) =>
  Effect.fromResult(
    snapshot.collections[0] === undefined
      ? Result.fail(new CatalogScenarioFailure({ message: "Expected collection" }))
      : Result.succeed(snapshot.collections[0]),
  )

const original = { name: "original.txt", size: 3, lastModified: 10, fingerprint: "original", source: "first-source" }
const replacement = { name: "changed.txt", size: 7, lastModified: 20, fingerprint: "changed", source: "replacement-source" }

export interface CatalogScenario {
  readonly name: string
  readonly run: Effect.Effect<void, CatalogError | CatalogScenarioFailure, Catalog>
}

/** Each scenario needs an isolated, initially disabled and empty implementation. */
export const catalogScenarios: readonly CatalogScenario[] = [
  {
    name: "consent fences stale work and clearing never reuses identifiers",
    run: Effect.gen(function* () {
      const catalog = yield* Catalog
      const initial = yield* catalog.read
      yield* check(!initial.enabled && initial.files.length === 0, "Fresh catalog must require consent")
      const disabled = yield* Effect.result(catalog.mutate({ type: "index", incoming: [original], epoch: initial.epoch }))
      yield* check(Result.isFailure(disabled) && disabled.failure._tag === "CatalogConflict", "Disabled indexing must conflict")
      const enabled = yield* catalog.mutate({ type: "configure", enabled: true, epoch: initial.epoch })
      const indexed = yield* catalog.mutate({ type: "index", incoming: [original], epoch: enabled.epoch })
      const previous = yield* firstFile(indexed)
      const cleared = yield* catalog.mutate({ type: "configure", enabled: false, epoch: indexed.epoch })
      yield* check(cleared.files.length === 0 && cleared.collections.length === 0, "Disable must clear metadata")
      const reenabled = yield* catalog.mutate({ type: "configure", enabled: true, epoch: cleared.epoch })
      const current = yield* catalog.mutate({ type: "index", incoming: [original], epoch: reenabled.epoch })
      const next = yield* firstFile(current)
      yield* check(next.identifier > previous.identifier, "Clearing must not reset allocation")
      const staleEpoch = yield* Effect.result(catalog.mutate({ type: "configure", enabled: false, epoch: indexed.epoch }))
      yield* check(Result.isFailure(staleEpoch) && staleEpoch.failure._tag === "CatalogConflict", "Old consent epoch must not disable a newer session")
      const aba = yield* Effect.result(catalog.mutate({ type: "deleteFile", file: previous, epoch: current.epoch }))
      yield* check(Result.isFailure(aba) && aba.failure._tag === "CatalogConflict", "Deleted identity must not refer to a replacement")
    }),
  },
  {
    name: "reconnect preserves baseline until approval and stale approval is atomic",
    run: Effect.gen(function* () {
      const catalog = yield* Catalog
      const enabled = yield* catalog.mutate({ type: "configure", enabled: true, epoch: (yield* catalog.read).epoch })
      const indexed = yield* catalog.mutate({ type: "index", incoming: [original, original], epoch: enabled.epoch })
      const previous = yield* firstFile(indexed)
      const connected = yield* catalog.mutate({ type: "reconnect", previous, current: replacement, epoch: indexed.epoch })
      const current = yield* firstFile(connected)
      yield* check(
        current.name === original.name &&
          current.size === original.size &&
          current.lastModified === original.lastModified &&
          current.fingerprint === original.fingerprint &&
          current.source === replacement.source &&
          current.revision === previous.revision + 1,
        "Reconnect must replace source, not approve content",
      )
      const second = yield* firstFile({ ...indexed, files: indexed.files.slice(1) })

      const stale = yield* Effect.result(
        catalog.mutate({
          type: "approve",
          reviewed: [
            { previous: current, current: replacement },
            { previous: { ...second, revision: second.revision + 1 }, current: replacement },
          ],
          epoch: connected.epoch,
        }),
      )

      yield* check(Result.isFailure(stale) && stale.failure._tag === "CatalogConflict", "Stale batch must reject")
      yield* check((yield* firstFile(yield* catalog.read)).revision === current.revision, "Rejected batch must commit no prefix")
      const approved = yield* catalog.mutate({ type: "approve", reviewed: [{ previous: current, current: replacement }], epoch: connected.epoch })
      const accepted = yield* firstFile(approved)
      yield* check(
        accepted.fingerprint === replacement.fingerprint &&
          accepted.name === replacement.name &&
          accepted.size === replacement.size &&
          accepted.lastModified === replacement.lastModified &&
          accepted.revision === current.revision + 1,
        "Approval must update baseline",
      )
      const reconnect = yield* catalog.mutate({ type: "reconnect", previous: accepted, current: original, epoch: approved.epoch })
      const restored = yield* firstFile(reconnect)
      yield* check(restored.fingerprint === replacement.fingerprint, "Reconnecting old content must not restore old approval")
    }),
  },
  {
    name: "collections enforce membership, revisions, default derivation and deletion cleanup",
    run: Effect.gen(function* () {
      const catalog = yield* Catalog
      const enabled = yield* catalog.mutate({ type: "configure", enabled: true, epoch: (yield* catalog.read).epoch })
      const indexed = yield* catalog.mutate({ type: "index", incoming: [original], epoch: enabled.epoch })
      const file = yield* firstFile(indexed)
      const created = yield* catalog.mutate({ type: "create", name: "Collection", epoch: indexed.epoch })
      const empty = yield* firstCollection(created)
      const added = yield* catalog.mutate({ type: "add", collection: empty, selected: [file, file], epoch: created.epoch })
      const collection = yield* firstCollection(added)
      yield* check(collection.fileIdentifiers.length === 1 && collection.revision === empty.revision + 1, "Membership must be unique and revisioned")
      const stale = yield* Effect.result(catalog.mutate({ type: "deleteCollection", collection: empty, epoch: added.epoch }))
      yield* check(Result.isFailure(stale), "Stale collection edit must reject")
      const removed = yield* catalog.mutate({ type: "remove", collection, file, epoch: added.epoch })
      const without = yield* firstCollection(removed)
      yield* check(without.fileIdentifiers.length === 0 && removed.files.length === 1, "Removing membership must retain indexed file")
      const missing = yield* Effect.result(catalog.mutate({ type: "remove", collection: without, file, epoch: removed.epoch }))
      yield* check(Result.isFailure(missing), "Removing absent membership must reject")
      const readded = yield* catalog.mutate({ type: "add", collection: without, selected: [file], epoch: removed.epoch })
      const deleted = yield* catalog.mutate({ type: "deleteFile", file, epoch: readded.epoch })
      yield* check(
        (yield* firstCollection(deleted)).fileIdentifiers.length === 0 && deriveMyFiles(deleted).fileIdentifiers.length === 0,
        "File deletion must clean every view",
      )
      const defaultEdit = yield* Effect.result(catalog.mutate({ type: "deleteCollection", collection: deriveMyFiles(deleted), epoch: deleted.epoch }))
      yield* check(Result.isFailure(defaultEdit), "Derived default collection must not be editable")
      const finalCollection = yield* firstCollection(deleted)
      const gone = yield* catalog.mutate({ type: "deleteCollection", collection: finalCollection, epoch: deleted.epoch })
      yield* check(gone.collections.length === 0, "Collection deletion must remove only collection")
      const invalid = yield* Effect.result(catalog.mutate({ type: "create", name: "  ", epoch: gone.epoch }))
      yield* check(Result.isFailure(invalid) && invalid.failure._tag === "InvalidCollectionName", "Blank collection name must have typed error")
    }),
  },
  {
    name: "review requires exact collection selection and rejects changed default membership",
    run: Effect.gen(function* () {
      const catalog = yield* Catalog
      const enabled = yield* catalog.mutate({ type: "configure", enabled: true, epoch: (yield* catalog.read).epoch })
      const indexed = yield* catalog.mutate({ type: "index", incoming: [original, replacement], epoch: enabled.epoch })
      const created = yield* catalog.mutate({ type: "create", name: "Review", epoch: indexed.epoch })
      const added = yield* catalog.mutate({ type: "add", collection: yield* firstCollection(created), selected: indexed.files, epoch: created.epoch })
      const collection = yield* firstCollection(added)
      const reviewed = added.files.map((previous: LibraryEntry) => ({ previous, current: replacement }))
      const partial = yield* Effect.result(catalog.mutate({ type: "approve", collection, reviewed: reviewed.slice(0, 1), epoch: added.epoch }))
      yield* check(Result.isFailure(partial), "Partial collection review must reject")
      const first = yield* firstFile(added)

      const duplicate = yield* Effect.result(
        catalog.mutate({
          type: "approve",
          collection,
          reviewed: [
            { previous: first, current: replacement },
            { previous: first, current: replacement },
          ],
          epoch: added.epoch,
        }),
      )

      yield* check(Result.isFailure(duplicate), "Duplicate review must reject")

      const forged = yield* Effect.result(
        catalog.mutate({
          type: "approve",
          collection: { ...collection, fileIdentifiers: [first.identifier] },
          reviewed: [{ previous: first, current: replacement }],
          epoch: added.epoch,
        }),
      )

      yield* check(Result.isFailure(forged), "Forged subset at same revision must reject")
      const defaultCollection = deriveMyFiles(added)
      const changed = yield* catalog.mutate({ type: "index", incoming: [original], epoch: added.epoch })
      const defaultReview = yield* Effect.result(catalog.mutate({ type: "approve", collection: defaultCollection, reviewed, epoch: changed.epoch }))
      yield* check(Result.isFailure(defaultReview), "Changed default membership must reject reviewed selection")

      const extra = yield* Effect.result(
        catalog.mutate({ type: "approve", collection, reviewed: changed.files.map((previous) => ({ previous, current: replacement })), epoch: changed.epoch }),
      )

      yield* check(Result.isFailure(extra), "Extra reviewed file outside collection must reject")
      const approved = yield* catalog.mutate({ type: "approve", collection, reviewed, epoch: changed.epoch })
      yield* check(
        approved.files.filter((entry) => collection.fileIdentifiers.includes(entry.identifier)).every((entry) => entry.revision === 1),
        "Unrelated indexing must not invalidate custom collection",
      )
    }),
  },
]
