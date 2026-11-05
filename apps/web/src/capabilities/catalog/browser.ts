import { Data, Effect, Layer, Predicate, Result, Schema } from "effect"
import type { CatalogCommand, CatalogError, CatalogPlan, IndexedVersion as PortableVersion, LibrarySnapshot } from "@file-transfer/catalog"
import { Catalog, CatalogConsent, CatalogStorageError, LibraryCollection, LibraryEntry, decide } from "@file-transfer/catalog"
import { leafHash, toHex, treeHash } from "@file-transfer/parcel"

/** Browser ABI adapter. IndexedDB has no native Effect transaction interpreter.
 * Replace this bridge when the browser platform provides multi-store atomicity.
 * Each operation owns its connection and transaction. Interruption aborts pending
 * writes; only oncomplete publishes native Files. Version 1/2 row names and handle
 * sidecars are retained. Neither core metadata nor IndexedDB receives File bytes.
 */
const FileHandle = Schema.declare<FileSystemFileHandle>(
  (value): value is FileSystemFileHandle => typeof FileSystemFileHandle !== "undefined" && value instanceof FileSystemFileHandle,
)

const StoredFile = Schema.Struct({ ...LibraryEntry.fields, handle: Schema.optional(FileHandle) })
const decodeFiles = Schema.decodeUnknownSync(Schema.Array(StoredFile))
const decodeCollections = Schema.decodeUnknownSync(Schema.Array(LibraryCollection))
const decodeConsent = Schema.decodeUnknownSync(CatalogConsent)
const decodeIdentifier = Schema.decodeUnknownSync(Schema.Int)

export type IndexedVersion = PortableVersion & { readonly handle?: FileSystemFileHandle; readonly file?: File }

export interface ReviewedFile {
  readonly previous: LibraryEntry
  readonly current: IndexedVersion
  readonly file: File
  readonly changed: boolean
}

interface InspectedFile {
  readonly file: File
  readonly current: IndexedVersion
}

export class LibraryStorageError extends Data.TaggedError("LibraryStorageError")<{ readonly cause: unknown }> {}

interface NativeSource {
  readonly epoch: number
  readonly revision: number
  readonly source: string
  handle?: FileSystemFileHandle
  file?: File
}

// Page-owned capabilities never enter portable snapshots or publish before commit.
const sources = new Map<number, NativeSource>()

/** Pure descriptor for rendering, refreshed by every committed read. */
export const sourceAvailability = (entry: LibraryEntry): "durable" | "transient" | "missing" => {
  if (entry.source?.startsWith("durable:") === true) {
    return "durable"
  }

  if (entry.source?.startsWith("transient:") === true) {
    return "transient"
  }

  return "missing"
}

const portableVersion = ({ name, size, lastModified, fingerprint, source }: PortableVersion): PortableVersion =>
  source === undefined ? { name, size, lastModified, fingerprint } : { name, size, lastModified, fingerprint, source }

type NativeCommand = (retain: (candidate: IndexedVersion) => PortableVersion) => CatalogCommand

const transaction = (operation?: CatalogCommand | NativeCommand) =>
  Effect.callback<LibrarySnapshot, CatalogError>((resume) => {
    let database: IDBDatabase | undefined
    let active: IDBTransaction | undefined
    let cancelled = false
    let failure: CatalogError | undefined
    let snapshot: LibrarySnapshot | undefined
    let published = new Map<number, NativeSource>()
    const candidates = new Map<string, IndexedVersion>()
    const pending = new Map<number, NativeSource>()

    const command = Predicate.isFunction(operation)
      ? operation((candidate) => {
          if (candidate.handle === undefined && candidate.file === undefined) {
            return portableVersion(candidate)
          }

          const source = `candidate:${candidates.size}`
          candidates.set(source, candidate)

          return { ...portableVersion(candidate), source }
        })
      : operation

    const fail = (cause: unknown) => {
      resume(Effect.fail(new CatalogStorageError({ cause })))
    }

    let request: IDBOpenDBRequest

    try {
      request = indexedDB.open("local-library", 2)
    } catch (error) {
      fail(error)

      return
    }

    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        request.result.createObjectStore("files", { keyPath: "identifier", autoIncrement: true })
        request.result.createObjectStore("collections", { keyPath: "identifier", autoIncrement: true })
        request.result.createObjectStore("settings")
      }
    }

    request.addEventListener("error", () => {
      fail(request.error)
    })
    request.onblocked = () => {
      cancelled = true
      fail(new DOMException("Close other Library tabs and try again.", "BlockedError"))
    }

    request.onsuccess = () => {
      database = request.result

      if (cancelled) {
        database.close()

        return
      }

      database.onversionchange = () => database?.close()

      try {
        const current = database.transaction(["files", "collections", "settings"], command === undefined ? "readonly" : "readwrite")
        active = current
        const files = current.objectStore("files")
        const collections = current.objectStore("collections")
        const settings = current.objectStore("settings")
        let rows: readonly (typeof StoredFile.Type)[] = []

        const guard = (action: () => void) => {
          try {
            action()
          } catch (error) {
            failure = new CatalogStorageError({ cause: error })
            current.abort()
          }
        }

        const load = (loaded: (value: LibrarySnapshot) => void) => {
          const consentRequest = settings.get("consent")
          const fileRequest = files.getAll()
          const collectionRequest = collections.getAll()
          let remaining = 3

          const complete = () => {
            guard(() => {
              if (--remaining !== 0) {
                return
              }

              const consent = decodeConsent(consentRequest.result ?? { enabled: false, epoch: 0 })
              rows = decodeFiles(fileRequest.result)
              const native = new Map<number, NativeSource>()

              const entries = rows.map((row): LibraryEntry => {
                const { handle, ...metadata } = row
                const retained = pending.get(row.identifier) ?? sources.get(row.identifier)

                if (consent.enabled && handle !== undefined) {
                  const source = row.source ?? `durable:legacy:${row.identifier}:${row.revision}`
                  native.set(row.identifier, { epoch: consent.epoch, revision: row.revision, source, handle })

                  return { ...metadata, source }
                }

                if (
                  consent.enabled &&
                  retained !== undefined &&
                  retained.epoch === consent.epoch &&
                  retained.revision === row.revision &&
                  retained.source === row.source
                ) {
                  native.set(row.identifier, retained)

                  return metadata
                }

                // A transient descriptor is meaningful only in the page retaining its File.
                if (metadata.source?.startsWith("transient:") === true) {
                  const { source: _source, ...missing } = metadata

                  return missing
                }

                return metadata
              })

              published = native
              loaded({ ...consent, files: entries, collections: decodeCollections(collectionRequest.result) })
            })
          }

          consentRequest.onsuccess = complete
          fileRequest.onsuccess = complete
          collectionRequest.onsuccess = complete
        }

        const apply = (plan: CatalogPlan, before: LibrarySnapshot, index = 0): void => {
          const mutation = plan[index]

          if (mutation === undefined) {
            load((value) => {
              snapshot = value
            })

            return
          }

          const next = () => {
            guard(() => {
              apply(plan, before, index + 1)
            })
          }

          const persist = (entry: LibraryEntry) => {
            const candidate = entry.source === undefined ? undefined : candidates.get(entry.source)

            if (candidate !== undefined) {
              const source = `${candidate.handle === undefined ? "transient" : "durable"}:${before.epoch}:${entry.identifier}:${entry.revision}`

              const native: NativeSource = {
                epoch: before.epoch,
                revision: entry.revision,
                source,
              }

              if (candidate.handle !== undefined) {
                native.handle = candidate.handle
              }

              if (candidate.file !== undefined) {
                native.file = candidate.file
              }

              pending.set(entry.identifier, native)

              return candidate.handle === undefined ? { ...entry, source } : { ...entry, source, handle: candidate.handle }
            }

            const old = rows.find((row) => row.identifier === entry.identifier)
            const oldSource = old?.source ?? (old?.handle === undefined ? undefined : `durable:legacy:${old.identifier}:${old.revision}`)
            const retained = sources.get(entry.identifier)

            if (retained !== undefined && retained.epoch === before.epoch && retained.revision === old?.revision && retained.source === entry.source) {
              pending.set(entry.identifier, { ...retained, revision: entry.revision })
            }

            return old?.handle !== undefined && entry.source === oldSource ? { ...entry, handle: old.handle } : entry
          }

          switch (mutation.type) {
            case "settings": {
              settings.put(mutation.consent, "consent").onsuccess = next
              break
            }

            case "clear": {
              files.clear().onsuccess = () => {
                guard(() => {
                  collections.clear().onsuccess = next
                })
              }

              break
            }

            case "addFile": {
              const added = files.add(mutation.entry)
              added.onsuccess = () => {
                guard(() => {
                  const identifier = decodeIdentifier(added.result)
                  files.put(persist({ ...mutation.entry, identifier })).onsuccess = next
                })
              }

              break
            }

            case "putFile": {
              files.put(persist(mutation.entry)).onsuccess = next
              break
            }

            case "deleteFile": {
              files.delete(mutation.identifier).onsuccess = next
              break
            }

            case "addCollection": {
              collections.add(mutation.collection).onsuccess = next
              break
            }

            case "putCollection": {
              collections.put(mutation.collection).onsuccess = next
              break
            }

            case "deleteCollection": {
              collections.delete(mutation.identifier).onsuccess = next
              break
            }
          }
        }

        current.oncomplete = () => {
          database?.close()

          if (cancelled || snapshot === undefined) {
            return
          }

          sources.clear()

          for (const [identifier, source] of published) {
            sources.set(identifier, source)
          }

          resume(Effect.succeed(snapshot))
        }

        current.addEventListener("abort", () => {
          database?.close()

          if (!cancelled) {
            resume(Effect.fail(failure ?? new CatalogStorageError({ cause: current.error })))
          }
        })

        load((value) => {
          if (command === undefined) {
            snapshot = value

            return
          }

          const plan = decide(value, command)

          if (Result.isFailure(plan)) {
            failure = plan.failure
            current.abort()

            return
          }

          apply(plan.success, value)
        })
      } catch (error) {
        try {
          active?.abort()
        } catch {
          /* Already terminal. */
        }

        database.close()
        fail(error)
      }
    }

    return Effect.sync(() => {
      cancelled = true

      try {
        active?.abort()
      } catch {
        /* Already committed or aborted. */
      }

      database?.close()
    })
  })

// Preserve the browser UI error contract while the shared service retains domain errors.
const browserTransaction = (operation?: CatalogCommand | NativeCommand) =>
  transaction(operation).pipe(
    Effect.mapError((failure) => {
      switch (failure._tag) {
        case "CatalogStorageError": {
          return new LibraryStorageError({ cause: failure.cause })
        }

        case "InvalidCollectionName": {
          return new LibraryStorageError({ cause: new DOMException("Name the collection.", "DataError") })
        }

        case "CatalogConflict": {
          return new LibraryStorageError({
            cause: new DOMException("The catalog changed in another tab. Reload the Library and review again.", "InvalidStateError"),
          })
        }
      }
    }),
  )

export const readLibrary = browserTransaction()
export const catalogLayer = Layer.succeed(Catalog, Catalog.of({ read: transaction(), mutate: (command) => transaction(command) }))
export const configureCatalog = (enabled: boolean, epoch: number) => browserTransaction({ type: "configure", enabled, epoch })

export const rememberFiles = (incoming: readonly IndexedVersion[], epoch: number) =>
  browserTransaction((retain) => ({ type: "index", incoming: incoming.map(retain), epoch }))

export const createCollection = (name: string, epoch: number) => browserTransaction({ type: "create", name, epoch })

export const addToCollection = (collection: LibraryCollection, selected: readonly LibraryEntry[], epoch: number) =>
  browserTransaction({ type: "add", collection, selected, epoch })

export const removeFromCollection = (collection: LibraryCollection, file: LibraryEntry, epoch: number) =>
  browserTransaction({ type: "remove", collection, file, epoch })

export const deleteCollection = (collection: LibraryCollection, epoch: number) => browserTransaction({ type: "deleteCollection", collection, epoch })
export const deleteFile = (file: LibraryEntry, epoch: number) => browserTransaction({ type: "deleteFile", file, epoch })

export const reconnectFile = (previous: LibraryEntry, entry: IndexedVersion, epoch: number) =>
  browserTransaction((retain) => ({ type: "reconnect", previous, current: retain(entry), epoch }))

/** Approves only the actual reviewed versions and the exact reviewed membership. */
export const approveVersions = (reviewed: readonly ReviewedFile[], epoch: number, collection?: LibraryCollection) =>
  browserTransaction((retain) => {
    const command = {
      type: "approve" as const,
      reviewed: reviewed.map((entry) => ({ previous: entry.previous, current: retain({ ...entry.current, file: entry.file }) })),
      epoch,
    }

    return collection === undefined ? command : { ...command, collection }
  })

declare global {
  interface Window {
    showOpenFilePicker?: (options: { multiple: boolean }) => Promise<FileSystemFileHandle[]>
  }

  interface FileSystemHandle {
    requestPermission: (options: { mode: "read" }) => Promise<PermissionState>
  }
}

/** Local fingerprint v1: RFC 6962 tree of 1 MiB plaintext chunk leaf hashes.
 * Keeps at most a chunk plus 32 bytes per chunk, never a whole file buffer.
 * Fingerprints stay local. Reuses parcel primitives without changing the wire format.
 */
const fingerprintFile = (file: File) =>
  Effect.tryPromise({
    try: async (signal) => {
      const hashes: Uint8Array[] = []

      for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
        signal.throwIfAborted()
        hashes.push(await leafHash(new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer())))
      }

      if (hashes.length === 0) {
        hashes.push(await leafHash(new Uint8Array(0)))
      }

      return `v1:${toHex(await treeHash(hashes))}`
    },
    catch: (cause) => new LibraryStorageError({ cause }),
  })

export const indexCatalogFiles = Effect.fnUntraced(function* (files: readonly File[]) {
  const entries: IndexedVersion[] = []

  for (const file of files) {
    const fingerprint = yield* fingerprintFile(file)
    entries.push({ name: file.name, size: file.size, lastModified: file.lastModified, fingerprint, file })
  }

  return entries
})

const inspectHandle = Effect.fnUntraced(function* (handle: FileSystemFileHandle) {
  const file = yield* Effect.tryPromise({ try: async () => await handle.getFile(), catch: (cause) => new LibraryStorageError({ cause }) })
  const fingerprint = yield* fingerprintFile(file)

  return { file, current: { name: file.name, size: file.size, lastModified: file.lastModified, fingerprint, handle } }
})

export const chooseCatalogFiles = Effect.fnUntraced(function* (multiple: boolean) {
  const handles = yield* Effect.tryPromise({
    try: async () => {
      if (window.showOpenFilePicker === undefined) {
        throw new DOMException(
          "This browser cannot remember durable file references. Add files to the Library and reselect them to include later edits.",
          "NotSupportedError",
        )
      }

      return await window.showOpenFilePicker({ multiple })
    },
    catch: (cause) => new LibraryStorageError({ cause }),
  })

  const entries: IndexedVersion[] = []

  for (const handle of handles) {
    entries.push((yield* inspectHandle(handle)).current)
  }

  return entries
})

/** Resolves actual browser capabilities, never capabilities smuggled into metadata.
 * Permission prompts occur only during explicit review, not indexing or rendering.
 * Native getFile/permission promises cannot be aborted; late results have no side effects.
 */
export const inspectCatalogSource = Effect.fnUntraced(function* (source: {
  readonly file?: File
  readonly handle?: FileSystemFileHandle
}): Effect.fn.Return<InspectedFile, LibraryStorageError> {
  if (source.handle !== undefined) {
    const { handle } = source

    const permission = yield* Effect.tryPromise({
      try: async () => await handle.requestPermission({ mode: "read" }),
      catch: (cause) => new LibraryStorageError({ cause }),
    })

    if (permission !== "granted") {
      return yield* new LibraryStorageError({ cause: new DOMException("Read access was not granted. Allow access or reconnect the file.", "NotAllowedError") })
    }

    return yield* inspectHandle(handle)
  }

  if (source.file === undefined) {
    return yield* new LibraryStorageError({ cause: new DOMException("Reselect this file before sharing.", "NotFoundError") })
  }

  const { file } = source
  const fingerprint = yield* fingerprintFile(file)

  return { file, current: { name: file.name, size: file.size, lastModified: file.lastModified, fingerprint, file } }
})

export const reviewCatalogFiles = Effect.fnUntraced(function* (entries: LibrarySnapshot["files"]) {
  const reviewed: ReviewedFile[] = []

  for (const previous of entries) {
    const source = sources.get(previous.identifier)
    const matching = source !== undefined && source.revision === previous.revision && source.source === previous.source ? source : {}
    const { file, current } = yield* inspectCatalogSource(matching)
    reviewed.push({
      previous,
      current,
      file,
      changed:
        previous.name !== current.name ||
        previous.size !== current.size ||
        previous.lastModified !== current.lastModified ||
        previous.fingerprint !== current.fingerprint,
    })
  }

  return reviewed
})
