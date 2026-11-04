import { Effect, Schema } from "effect"
import { leafHash, toHex, treeHash } from "@file-transfer/parcel"

/** Browser boundary: IndexedDB stores metadata and file handles, never file bytes.
 * DOM callbacks keep the multi-store transaction and consent fence atomic.
 * Transactions serialize consent and catalog edits across tabs; interruption aborts pending writes.
 */
const FileHandle = Schema.declare<FileSystemFileHandle>(
  (value): value is FileSystemFileHandle => typeof FileSystemFileHandle !== "undefined" && value instanceof FileSystemFileHandle,
)
const FileVersion = Schema.Struct({
  name: Schema.String,
  size: Schema.Finite,
  lastModified: Schema.Finite,
  fingerprint: Schema.String,
  handle: Schema.optional(FileHandle),
})
const StoredFile = Schema.Struct({ identifier: Schema.Int, revision: Schema.Int, ...FileVersion.fields })
const Collection = Schema.Struct({ identifier: Schema.Int, revision: Schema.Int, name: Schema.NonEmptyString, fileIdentifiers: Schema.Array(Schema.Int) })
const Consent = Schema.Struct({ enabled: Schema.Boolean, epoch: Schema.Int })
const Snapshot = Schema.Struct({ ...Consent.fields, files: Schema.Array(StoredFile), collections: Schema.Array(Collection) })
export type LibrarySnapshot = Omit<typeof Snapshot.Type, "files"> & { readonly files: ReadonlyArray<typeof StoredFile.Type & { readonly file?: File }> }
export type IndexedVersion = typeof FileVersion.Type & { readonly file?: File }
export type LibraryCollection = typeof Collection.Type
export interface ReviewedFile {
  readonly previous: LibrarySnapshot["files"][number]
  readonly current: IndexedVersion
  readonly file: File
  readonly changed: boolean
}

export class LibraryStorageError extends Schema.TaggedError<LibraryStorageError>()("LibraryStorageError", { cause: Schema.Defect() }) {}
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot)
const decodeConsent = Schema.decodeUnknownSync(Consent)
const conflict = () => new DOMException("The catalog changed in another tab. Reload the Library and review again.", "InvalidStateError")
type Edit = (snapshot: LibrarySnapshot, files: IDBObjectStore, collections: IDBObjectStore, settings: IDBObjectStore, committed: Array<() => void>) => void

// Page-owned snapshots are published only after commit and fenced by consent/revision.
const transientFiles = new Map<number, { readonly epoch: number; readonly revision: number; readonly file: File }>()
const persistedVersion = ({ name, size, lastModified, fingerprint, handle }: IndexedVersion): typeof FileVersion.Type => ({
  name,
  size,
  lastModified,
  fingerprint,
  ...(handle === undefined ? {} : { handle }),
})
const retainFile = (identifier: number, revision: number, epoch: number, entry: IndexedVersion) => {
  if (entry.file === undefined) transientFiles.delete(identifier)
  else transientFiles.set(identifier, { epoch, revision, file: entry.file })
}

/** Derived membership is never persisted or edited. Identifier zero is reserved. */
export const deriveMyFiles = (snapshot: LibrarySnapshot): LibraryCollection => ({
  identifier: 0,
  revision: 0,
  name: "My files",
  fileIdentifiers: snapshot.files.map((entry) => entry.identifier),
})

type Operation =
  | { readonly mode: "read" }
  | { readonly mode: "configure"; readonly edit: Edit }
  | { readonly mode: "edit"; readonly epoch: number; readonly edit: Edit }

const transaction = (operation: Operation) =>
  Effect.callback<LibrarySnapshot, LibraryStorageError>((resume) => {
    let database: IDBDatabase | undefined
    let active: IDBTransaction | undefined
    let cancelled = false
    let failure: unknown
    const committed: Array<() => void> = []
    const fail = (cause: unknown) => resume(Effect.fail(new LibraryStorageError({ cause })))
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open("local-library", 2)
    } catch (cause) {
      fail(cause)
      return
    }
    request.onupgradeneeded = (event) => {
      // Version 2 accepts absent handles without rewriting or dropping version 1 data.
      if (event.oldVersion === 0) {
        request.result.createObjectStore("files", { keyPath: "identifier", autoIncrement: true })
        request.result.createObjectStore("collections", { keyPath: "identifier", autoIncrement: true })
        request.result.createObjectStore("settings")
      }
    }
    request.onerror = () => fail(request.error)
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
        const current = database.transaction(["files", "collections", "settings"], operation.mode === "read" ? "readonly" : "readwrite")
        active = current
        const files = current.objectStore("files")
        const collections = current.objectStore("collections")
        const settings = current.objectStore("settings")
        const consentRequest = settings.get("consent")
        const fileRequest = files.getAll()
        const collectionRequest = collections.getAll()
        let completed = 0
        let snapshot: LibrarySnapshot | undefined
        const loaded = () => {
          if (++completed !== 3) return
          try {
            const consent = decodeConsent(consentRequest.result ?? { enabled: false, epoch: 0 })
            const stored = decodeSnapshot({ ...consent, files: fileRequest.result, collections: collectionRequest.result })
            snapshot = {
              ...stored,
              files: stored.files.map((entry) => {
                const transient = transientFiles.get(entry.identifier)
                return stored.enabled && transient !== undefined && transient.epoch === stored.epoch && transient.revision === entry.revision
                  ? { ...entry, file: transient.file }
                  : entry
              }),
            }
            if (operation.mode === "edit" && (!snapshot.enabled || snapshot.epoch !== operation.epoch)) throw conflict()
            if (operation.mode !== "read") operation.edit(snapshot, files, collections, settings, committed)
          } catch (cause) {
            failure = cause
            current.abort()
          }
        }
        fileRequest.onsuccess = loaded
        collectionRequest.onsuccess = loaded
        consentRequest.onsuccess = loaded
        current.oncomplete = () => {
          database?.close()
          if (snapshot !== undefined) {
            for (const [identifier, transient] of transientFiles) {
              if (
                !snapshot.enabled ||
                transient.epoch !== snapshot.epoch ||
                !snapshot.files.some((entry) => entry.identifier === identifier && entry.revision === transient.revision)
              )
                transientFiles.delete(identifier)
            }
          }
          for (const publish of committed) publish()
          if (snapshot !== undefined) resume(Effect.succeed(snapshot))
        }
        current.onabort = () => {
          database?.close()
          fail(failure ?? current.error)
        }
      } catch (cause) {
        database.close()
        fail(cause)
      }
    }
    return Effect.sync(() => {
      cancelled = true
      if (active !== undefined) {
        try {
          active.abort()
        } catch {
          /* Already committed or aborted. */
        }
      }
      database?.close()
    })
  })

export const readLibrary = transaction({ mode: "read" })

export const configureCatalog = (enabled: boolean) =>
  transaction({
    mode: "configure",
    edit: (snapshot, files, collections, settings, committed) => {
      settings.put({ enabled, epoch: snapshot.epoch + 1 }, "consent")
      committed.push(() => transientFiles.clear())
      if (!enabled) {
        files.clear()
        collections.clear()
      }
    },
  })

export const rememberFiles = (incoming: ReadonlyArray<IndexedVersion>, epoch: number) =>
  transaction({
    mode: "edit",
    epoch,
    edit: (_snapshot, files, _collections, _settings, committed) => {
      for (const entry of incoming) {
        const request = files.add({ revision: 0, ...persistedVersion(entry) })
        request.onsuccess = () => {
          const identifier = request.result
          if (typeof identifier === "number") committed.push(() => retainFile(identifier, 0, epoch, entry))
        }
      }
    },
  })

export const saveCollection = (name: string, fileIdentifiers: ReadonlyArray<number>, epoch: number) =>
  transaction({
    mode: "edit",
    epoch,
    edit: (snapshot, _files, collections) => {
      if (name.trim().length === 0) throw new DOMException("Name the collection.", "DataError")
      const existing = new Set(snapshot.files.map((entry) => entry.identifier))
      if (fileIdentifiers.some((identifier) => !existing.has(identifier))) throw conflict()
      collections.add({ revision: 0, name, fileIdentifiers: [...new Set(fileIdentifiers)] })
    },
  })

export const createCollection = (name: string, epoch: number) => saveCollection(name, [], epoch)

export const addToCollection = (identifier: number, fileIdentifiers: ReadonlyArray<number>, epoch: number) =>
  transaction({
    mode: "edit",
    epoch,
    edit: (snapshot, _files, collections) => {
      const collection = snapshot.collections.find((entry) => entry.identifier === identifier)
      const existing = new Set(snapshot.files.map((entry) => entry.identifier))
      if (collection === undefined || fileIdentifiers.some((value) => !existing.has(value))) throw conflict()
      collections.put({ ...collection, revision: collection.revision + 1, fileIdentifiers: [...new Set([...collection.fileIdentifiers, ...fileIdentifiers])] })
    },
  })

export const removeFromCollection = (identifier: number, fileIdentifier: number, epoch: number) =>
  transaction({
    mode: "edit",
    epoch,
    edit: (snapshot, _files, collections) => {
      const collection = snapshot.collections.find((entry) => entry.identifier === identifier)
      if (collection === undefined) throw conflict()
      collections.put({
        ...collection,
        revision: collection.revision + 1,
        fileIdentifiers: collection.fileIdentifiers.filter((value) => value !== fileIdentifier),
      })
    },
  })

export const deleteCollection = (identifier: number, epoch: number) =>
  transaction({
    mode: "edit",
    epoch,
    edit: (_snapshot, _files, collections) => {
      collections.delete(identifier)
    },
  })

export const deleteFile = (identifier: number, epoch: number) =>
  transaction({
    mode: "edit",
    epoch,
    edit: (snapshot, files, collections, _settings, committed) => {
      files.delete(identifier)
      committed.push(() => transientFiles.delete(identifier))
      for (const collection of snapshot.collections) {
        if (collection.fileIdentifiers.includes(identifier))
          collections.put({
            ...collection,
            revision: collection.revision + 1,
            fileIdentifiers: collection.fileIdentifiers.filter((value) => value !== identifier),
          })
      }
    },
  })

export const reconnectFile = (previous: LibrarySnapshot["files"][number], entry: IndexedVersion, epoch: number) =>
  transaction({
    mode: "edit",
    epoch,
    edit: (snapshot, files, _collections, _settings, committed) => {
      const existing = snapshot.files.find((file) => file.identifier === previous.identifier)
      if (existing === undefined || existing.revision !== previous.revision) throw conflict()
      const { handle: _previousHandle, ...baseline } = persistedVersion(existing)
      files.put({
        ...baseline,
        identifier: existing.identifier,
        revision: existing.revision + 1,
        ...(entry.handle === undefined ? {} : { handle: entry.handle }),
      })
      committed.push(() => retainFile(existing.identifier, existing.revision + 1, epoch, entry))
    },
  })

/** Never overwrites another tab's newer approval, changes reviewed membership, or restores forgotten references. */
export const approveVersions = (reviewed: ReadonlyArray<ReviewedFile>, epoch: number, collection?: LibraryCollection) =>
  transaction({
    mode: "edit",
    epoch,
    edit: (snapshot, files, _collections, _settings, committed) => {
      if (collection?.identifier === 0) {
        if (
          snapshot.files.length !== collection.fileIdentifiers.length ||
          snapshot.files.some((entry) => !collection.fileIdentifiers.includes(entry.identifier))
        )
          throw conflict()
      } else if (collection !== undefined) {
        const existing = snapshot.collections.find((entry) => entry.identifier === collection.identifier)
        if (existing === undefined || existing.revision !== collection.revision) throw conflict()
      }
      for (const entry of reviewed) {
        const existing = snapshot.files.find((file) => file.identifier === entry.previous.identifier)
        if (existing === undefined || existing.revision !== entry.previous.revision) throw conflict()
        files.put({ identifier: existing.identifier, revision: existing.revision + 1, ...persistedVersion(entry.current) })
        committed.push(() => retainFile(existing.identifier, existing.revision + 1, epoch, entry.current))
      }
    },
  })

declare global {
  interface Window {
    showOpenFilePicker?: (options: { multiple: boolean }) => Promise<Array<FileSystemFileHandle>>
  }
  interface FileSystemHandle {
    requestPermission(options: { mode: "read" }): Promise<PermissionState>
  }
}

/** Local fingerprint v1: RFC 6962 tree of 1 MiB plaintext chunk leaf hashes.
 * Keeps at most a chunk plus 32 bytes per chunk, never a whole file buffer.
 * Fingerprints stay local. Reuses parcel primitives without changing the wire format.
 */
const fingerprintFile = (file: File) =>
  Effect.tryPromise({
    try: async (signal) => {
      const hashes: Array<Uint8Array> = []
      for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
        signal.throwIfAborted()
        hashes.push(await leafHash(new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer())))
      }
      if (hashes.length === 0) hashes.push(await leafHash(new Uint8Array(0)))
      return "v1:" + toHex(await treeHash(hashes))
    },
    catch: (cause) => new LibraryStorageError({ cause }),
  })

export const indexCatalogFiles = Effect.fnUntraced(function* (files: ReadonlyArray<File>) {
  const entries: Array<IndexedVersion> = []
  for (const file of files) {
    const fingerprint = yield* fingerprintFile(file)
    entries.push({ name: file.name, size: file.size, lastModified: file.lastModified, fingerprint, file })
  }
  return entries
})

const inspectHandle = Effect.fnUntraced(function* (handle: FileSystemFileHandle) {
  const file = yield* Effect.tryPromise({ try: () => handle.getFile(), catch: (cause) => new LibraryStorageError({ cause }) })
  const fingerprint = yield* fingerprintFile(file)
  return { file, current: { name: file.name, size: file.size, lastModified: file.lastModified, fingerprint, handle } }
})

export const chooseCatalogFiles = Effect.fnUntraced(function* (multiple: boolean) {
  const handles = yield* Effect.tryPromise({
    try: () => {
      if (window.showOpenFilePicker === undefined)
        return Promise.reject(
          new DOMException(
            "This browser cannot remember durable file references. Add files to the Library and reselect them to include later edits.",
            "NotSupportedError",
          ),
        )
      return window.showOpenFilePicker({ multiple })
    },
    catch: (cause) => new LibraryStorageError({ cause }),
  })
  const entries: Array<IndexedVersion> = []
  for (const handle of handles) entries.push((yield* inspectHandle(handle)).current)
  return entries
})

export const reviewCatalogFiles = Effect.fnUntraced(function* (entries: LibrarySnapshot["files"]) {
  const reviewed: Array<ReviewedFile> = []
  for (const previous of entries) {
    let inspected: { readonly file: File; readonly current: IndexedVersion }
    if (previous.handle !== undefined) {
      const handle = previous.handle
      const permission = yield* Effect.tryPromise({
        try: () => handle.requestPermission({ mode: "read" }),
        catch: (cause) => new LibraryStorageError({ cause }),
      })
      if (permission !== "granted")
        return yield* new LibraryStorageError({
          cause: new DOMException("Read access was not granted. Allow access or reconnect the file.", "NotAllowedError"),
        })
      inspected = yield* inspectHandle(handle)
    } else {
      // This is a captured snapshot, not a live filesystem reference. The UI must
      // disclose this limitation and offer reselection to include later edits.
      if (previous.file === undefined) return yield* new LibraryStorageError({ cause: new DOMException("Reselect this file before sharing.", "NotFoundError") })
      const file = previous.file
      const fingerprint = yield* fingerprintFile(file)
      inspected = { file, current: { name: file.name, size: file.size, lastModified: file.lastModified, fingerprint, file } }
    }
    const { file, current } = inspected
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
