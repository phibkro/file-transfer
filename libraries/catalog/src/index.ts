import { Context, Data, Effect, Layer, Ref, Result, Schema } from "effect"

export const IndexedVersion = Schema.Struct({
  name: Schema.String,
  size: Schema.Finite,
  lastModified: Schema.Finite,
  fingerprint: Schema.String,
  source: Schema.optional(Schema.String),
})

export type IndexedVersion = typeof IndexedVersion.Type

export const LibraryEntry = Schema.Struct({ identifier: Schema.Int, revision: Schema.Int, ...IndexedVersion.fields })

export type LibraryEntry = typeof LibraryEntry.Type

export const LibraryCollection = Schema.Struct({
  identifier: Schema.Int,
  revision: Schema.Int,
  name: Schema.NonEmptyString,
  fileIdentifiers: Schema.Array(Schema.Int),
})

export type LibraryCollection = typeof LibraryCollection.Type

export const CatalogConsent = Schema.Struct({ enabled: Schema.Boolean, epoch: Schema.Int })

export type CatalogConsent = typeof CatalogConsent.Type

export const LibrarySnapshot = Schema.Struct({ ...CatalogConsent.fields, files: Schema.Array(LibraryEntry), collections: Schema.Array(LibraryCollection) })

export type LibrarySnapshot = typeof LibrarySnapshot.Type

export interface ReviewedVersion {
  readonly previous: LibraryEntry
  readonly current: IndexedVersion
}

export type CatalogCommand =
  | { readonly type: "configure"; readonly enabled: boolean; readonly epoch: number }
  | { readonly type: "index"; readonly incoming: readonly IndexedVersion[]; readonly epoch: number }
  | { readonly type: "create"; readonly name: string; readonly epoch: number }
  | { readonly type: "add"; readonly collection: LibraryCollection; readonly selected: readonly LibraryEntry[]; readonly epoch: number }
  | { readonly type: "remove"; readonly collection: LibraryCollection; readonly file: LibraryEntry; readonly epoch: number }
  | { readonly type: "deleteFile"; readonly file: LibraryEntry; readonly epoch: number }
  | { readonly type: "deleteCollection"; readonly collection: LibraryCollection; readonly epoch: number }
  | { readonly type: "reconnect"; readonly previous: LibraryEntry; readonly current: IndexedVersion; readonly epoch: number }
  | { readonly type: "approve"; readonly reviewed: readonly ReviewedVersion[]; readonly collection?: LibraryCollection; readonly epoch: number }

export type CatalogMutation =
  | { readonly type: "settings"; readonly consent: CatalogConsent }
  | { readonly type: "clear" }
  | { readonly type: "addFile"; readonly entry: Omit<LibraryEntry, "identifier"> }
  | { readonly type: "putFile"; readonly entry: LibraryEntry }
  | { readonly type: "deleteFile"; readonly identifier: number }
  | { readonly type: "addCollection"; readonly collection: Omit<LibraryCollection, "identifier"> }
  | { readonly type: "putCollection"; readonly collection: LibraryCollection }
  | { readonly type: "deleteCollection"; readonly identifier: number }

export type CatalogPlan = readonly CatalogMutation[]

export class CatalogConflict extends Data.TaggedError("CatalogConflict") {}

export class InvalidCollectionName extends Data.TaggedError("InvalidCollectionName") {}

export class CatalogStorageError extends Data.TaggedError("CatalogStorageError")<{ readonly cause: unknown }> {}

export type CatalogError = CatalogConflict | InvalidCollectionName | CatalogStorageError

/** Identifier zero is a derived view, never a stored collection. */
export const deriveMyFiles = (snapshot: LibrarySnapshot): LibraryCollection => ({
  identifier: 0,
  revision: 0,
  name: "My files",
  fileIdentifiers: snapshot.files.map((entry) => entry.identifier),
})

const currentFile = (snapshot: LibrarySnapshot, expected: LibraryEntry) =>
  snapshot.files.find((entry) => entry.identifier === expected.identifier && entry.revision === expected.revision)

const currentCollection = (snapshot: LibrarySnapshot, expected: LibraryCollection) =>
  snapshot.collections.find((entry) => entry.identifier !== 0 && entry.identifier === expected.identifier && entry.revision === expected.revision)

const version = ({ name, size, lastModified, fingerprint, source }: IndexedVersion): IndexedVersion =>
  source === undefined ? { name, size, lastModified, fingerprint } : { name, size, lastModified, fingerprint, source }

const conflict = (): Result.Result<never, CatalogConflict> => Result.fail(new CatalogConflict())

/** Pure decision over decoded values. The interpreter must read, decide and commit
 * in one transaction; plans cannot be replayed against a different snapshot.
 * Additions intentionally leave identifier allocation to the owning store.
 */
export const decide = (snapshot: LibrarySnapshot, command: CatalogCommand): Result.Result<CatalogPlan, CatalogError> => {
  if (command.epoch !== snapshot.epoch || (command.type !== "configure" && !snapshot.enabled)) {
    return conflict()
  }

  switch (command.type) {
    case "configure": {
      return Result.succeed(
        command.enabled
          ? [{ type: "settings", consent: { enabled: true, epoch: snapshot.epoch + 1 } }]
          : [{ type: "settings", consent: { enabled: false, epoch: snapshot.epoch + 1 } }, { type: "clear" }],
      )
    }

    case "index": {
      return Result.succeed(command.incoming.map((entry) => ({ type: "addFile", entry: { ...version(entry), revision: 0 } })))
    }

    case "create": {
      return command.name.trim().length === 0
        ? Result.fail(new InvalidCollectionName())
        : Result.succeed([{ type: "addCollection", collection: { name: command.name, revision: 0, fileIdentifiers: [] } }])
    }

    case "add": {
      const collection = currentCollection(snapshot, command.collection)

      if (collection === undefined || command.selected.some((entry) => currentFile(snapshot, entry) === undefined)) {
        return conflict()
      }

      return Result.succeed([
        {
          type: "putCollection",
          collection: {
            ...collection,
            revision: collection.revision + 1,
            fileIdentifiers: [...new Set([...collection.fileIdentifiers, ...command.selected.map((entry) => entry.identifier)])],
          },
        },
      ])
    }

    case "remove": {
      const collection = currentCollection(snapshot, command.collection)
      const file = currentFile(snapshot, command.file)

      if (collection === undefined || file === undefined || !collection.fileIdentifiers.includes(file.identifier)) {
        return conflict()
      }

      return Result.succeed([
        {
          type: "putCollection",
          collection: {
            ...collection,
            revision: collection.revision + 1,
            fileIdentifiers: collection.fileIdentifiers.filter((identifier) => identifier !== file.identifier),
          },
        },
      ])
    }

    case "deleteFile": {
      const file = currentFile(snapshot, command.file)

      if (file === undefined) {
        return conflict()
      }

      const plan: CatalogMutation[] = [{ type: "deleteFile", identifier: file.identifier }]

      for (const collection of snapshot.collections) {
        if (collection.fileIdentifiers.includes(file.identifier)) {
          plan.push({
            type: "putCollection",
            collection: {
              ...collection,
              revision: collection.revision + 1,
              fileIdentifiers: collection.fileIdentifiers.filter((identifier) => identifier !== file.identifier),
            },
          })
        }
      }

      return Result.succeed(plan)
    }

    case "deleteCollection": {
      const collection = currentCollection(snapshot, command.collection)

      return collection === undefined ? conflict() : Result.succeed([{ type: "deleteCollection", identifier: collection.identifier }])
    }

    case "reconnect": {
      const existing = currentFile(snapshot, command.previous)

      if (existing === undefined) {
        return conflict()
      }

      const { source: _source, ...baseline } = existing
      const entry = { ...baseline, revision: existing.revision + 1 }

      return Result.succeed([{ type: "putFile", entry: command.current.source === undefined ? entry : { ...entry, source: command.current.source } }])
    }

    case "approve": {
      const { collection } = command

      if (collection?.identifier === 0) {
        if (
          snapshot.files.length !== collection.fileIdentifiers.length ||
          snapshot.files.some((entry) => !collection.fileIdentifiers.includes(entry.identifier))
        ) {
          return conflict()
        }
      } else if (collection !== undefined) {
        const stored = currentCollection(snapshot, collection)

        if (
          stored === undefined ||
          stored.fileIdentifiers.length !== collection.fileIdentifiers.length ||
          stored.fileIdentifiers.some((identifier) => !collection.fileIdentifiers.includes(identifier))
        ) {
          return conflict()
        }
      }

      const identifiers = new Set(command.reviewed.map((entry) => entry.previous.identifier))

      if (
        identifiers.size !== command.reviewed.length ||
        (collection !== undefined &&
          (identifiers.size !== collection.fileIdentifiers.length || collection.fileIdentifiers.some((identifier) => !identifiers.has(identifier))))
      ) {
        return conflict()
      }

      const plan: CatalogMutation[] = []

      for (const entry of command.reviewed) {
        const existing = currentFile(snapshot, entry.previous)

        if (existing === undefined) {
          return conflict()
        }

        plan.push({ type: "putFile", entry: { identifier: existing.identifier, revision: existing.revision + 1, ...version(entry.current) } })
      }

      return Result.succeed(plan)
    }
  }
}

interface MemoryState {
  readonly snapshot: LibrarySnapshot
  readonly nextFileIdentifier: number
  readonly nextCollectionIdentifier: number
}

const apply = (state: MemoryState, plan: CatalogPlan): MemoryState => {
  let { nextFileIdentifier, nextCollectionIdentifier } = state
  let { enabled, epoch } = state.snapshot
  const files = new Map(state.snapshot.files.map((entry) => [entry.identifier, entry]))
  const collections = new Map(state.snapshot.collections.map((collection) => [collection.identifier, collection]))

  for (const mutation of plan) {
    switch (mutation.type) {
      case "settings": {
        enabled = mutation.consent.enabled
        epoch = mutation.consent.epoch
        break
      }

      case "clear": {
        files.clear()
        collections.clear()
        break
      }

      case "addFile": {
        const identifier = nextFileIdentifier++
        files.set(identifier, { ...mutation.entry, identifier })
        break
      }

      case "putFile": {
        files.set(mutation.entry.identifier, mutation.entry)
        break
      }

      case "deleteFile": {
        files.delete(mutation.identifier)
        break
      }

      case "addCollection": {
        const identifier = nextCollectionIdentifier++
        collections.set(identifier, { ...mutation.collection, identifier })
        break
      }

      case "putCollection": {
        collections.set(mutation.collection.identifier, mutation.collection)
        break
      }

      case "deleteCollection": {
        collections.delete(mutation.identifier)
        break
      }
    }
  }

  return { snapshot: { enabled, epoch, files: [...files.values()], collections: [...collections.values()] }, nextFileIdentifier, nextCollectionIdentifier }
}

/** Semantic capability. Implementations own storage and decode at their boundary.
 * Mutations execute lazily, atomically, without retries. The reference layer owns
 * transient state only, acquires no external resources and launches no fibers.
 * Interruption before execution cannot commit; each synchronous commit is indivisible.
 */
export class Catalog extends Context.Service<
  Catalog,
  {
    readonly read: Effect.Effect<LibrarySnapshot, CatalogError>
    readonly mutate: (command: CatalogCommand) => Effect.Effect<LibrarySnapshot, CatalogError>
  }
>()("@file-transfer/catalog/Catalog") {
  static readonly layer = Layer.effect(
    Catalog,
    Effect.gen(function* () {
      const state = yield* Ref.make<MemoryState>({
        snapshot: { enabled: false, epoch: 0, files: [], collections: [] },
        nextFileIdentifier: 1,
        nextCollectionIdentifier: 1,
      })

      const mutate = Effect.fnUntraced(function* (command: CatalogCommand) {
        const result = yield* Ref.modify(state, (current): readonly [Result.Result<LibrarySnapshot, CatalogError>, MemoryState] => {
          const plan = decide(current.snapshot, command)

          if (Result.isFailure(plan)) {
            return [Result.fail(plan.failure), current]
          }

          const updated = apply(current, plan.success)

          return [Result.succeed(updated.snapshot), updated]
        })

        return yield* Effect.fromResult(result)
      })

      return Catalog.of({ read: Ref.get(state).pipe(Effect.map((current) => current.snapshot)), mutate })
    }),
  )
}
