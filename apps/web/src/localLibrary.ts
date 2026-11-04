import { Effect, Schema } from "effect"
import { leafHash, toHex, treeHash } from "@file-transfer/parcel"

/** Browser boundary: IndexedDB stores metadata and file handles, never file bytes.
 * Effect 4.0.7 has no native IndexedDB adapter. Retire this adapter when one is installed.
 * Transactions serialize consent and catalog edits across tabs; interruption aborts pending writes.
 */
const FileHandle = Schema.declare<FileSystemFileHandle>(
  (value): value is FileSystemFileHandle => typeof FileSystemFileHandle !== "undefined" && value instanceof FileSystemFileHandle,
)
const FileVersion = Schema.Struct({ name: Schema.String, size: Schema.Finite, lastModified: Schema.Finite, fingerprint: Schema.String, handle: FileHandle })
const StoredFile = Schema.Struct({ identifier: Schema.Int, revision: Schema.Int, ...FileVersion.fields })
const Collection = Schema.Struct({ identifier: Schema.Int, revision: Schema.Int, name: Schema.NonEmptyString, fileIdentifiers: Schema.Array(Schema.Int) })
const Consent = Schema.Struct({ enabled: Schema.Boolean, epoch: Schema.Int })
const Snapshot = Schema.Struct({ ...Consent.fields, files: Schema.Array(StoredFile), collections: Schema.Array(Collection) })
export type LibrarySnapshot = typeof Snapshot.Type
export type IndexedVersion = typeof FileVersion.Type
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
type Edit = (snapshot: LibrarySnapshot, files: IDBObjectStore, collections: IDBObjectStore, settings: IDBObjectStore) => void

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
    const fail = (cause: unknown) => resume(Effect.fail(new LibraryStorageError({ cause })))
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open("local-library", 1)
    } catch (cause) {
      fail(cause)
      return
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore("files", { keyPath: "identifier", autoIncrement: true })
      request.result.createObjectStore("collections", { keyPath: "identifier", autoIncrement: true })
      request.result.createObjectStore("settings")
    }
    request.onerror = () => fail(request.error)
    request.onblocked = () => fail(new DOMException("Close other Library tabs and try again.", "BlockedError"))
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
            snapshot = decodeSnapshot({ ...consent, files: fileRequest.result, collections: collectionRequest.result })
            if (operation.mode === "edit" && (!snapshot.enabled || snapshot.epoch !== operation.epoch)) throw conflict()
            if (operation.mode !== "read") operation.edit(snapshot, files, collections, settings)
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
    edit: (snapshot, files, collections, settings) => {
      settings.put({ enabled, epoch: snapshot.epoch + 1 }, "consent")
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
    edit: (_snapshot, files) => {
      for (const entry of incoming) files.add({ revision: 0, ...entry })
    },
  })

export const saveCollection = (name: string, fileIdentifiers: ReadonlyArray<number>, epoch: number) =>
  transaction({
    mode: "edit",
    epoch,
    edit: (snapshot, _files, collections) => {
      const existing = new Set(snapshot.files.map((entry) => entry.identifier))
      if (fileIdentifiers.some((identifier) => !existing.has(identifier))) throw conflict()
      collections.add({ revision: 0, name, fileIdentifiers: [...new Set(fileIdentifiers)] })
    },
  })

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
    edit: (snapshot, files, collections) => {
      files.delete(identifier)
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
    edit: (snapshot, files) => {
      const existing = snapshot.files.find((file) => file.identifier === previous.identifier)
      if (existing === undefined || existing.revision !== previous.revision) throw conflict()
      files.put({ identifier: existing.identifier, revision: existing.revision + 1, ...entry })
    },
  })

/** Never overwrites another tab's newer approval, changes reviewed membership, or restores forgotten references. */
export const approveVersions = (reviewed: ReadonlyArray<ReviewedFile>, epoch: number, collection?: LibraryCollection) =>
  transaction({
    mode: "edit",
    epoch,
    edit: (snapshot, files) => {
      if (collection !== undefined) {
        const existing = snapshot.collections.find((entry) => entry.identifier === collection.identifier)
        if (existing === undefined || existing.revision !== collection.revision) throw conflict()
      }
      for (const entry of reviewed) {
        const existing = snapshot.files.find((file) => file.identifier === entry.previous.identifier)
        if (existing === undefined || existing.revision !== entry.previous.revision) throw conflict()
        files.put({ identifier: existing.identifier, revision: existing.revision + 1, ...entry.current })
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

const inspectHandle = Effect.fn("inspectHandle")(function* (handle: FileSystemFileHandle) {
  const file = yield* Effect.tryPromise({ try: () => handle.getFile(), catch: (cause) => new LibraryStorageError({ cause }) })
  const fingerprint = yield* fingerprintFile(file)
  return { file, current: { name: file.name, size: file.size, lastModified: file.lastModified, fingerprint, handle } }
})

export const chooseCatalogFiles = Effect.fn("chooseCatalogFiles")(function* (multiple: boolean) {
  const handles = yield* Effect.tryPromise({
    try: () => {
      if (window.showOpenFilePicker === undefined)
        return Promise.reject(
          new DOMException("This browser cannot remember file references. Use Quick Share and reselect files each time.", "NotSupportedError"),
        )
      return window.showOpenFilePicker({ multiple })
    },
    catch: (cause) => new LibraryStorageError({ cause }),
  })
  const entries: Array<IndexedVersion> = []
  for (const handle of handles) entries.push((yield* inspectHandle(handle)).current)
  return entries
})

export const reviewCatalogFiles = Effect.fn("reviewCatalogFiles")(function* (entries: LibrarySnapshot["files"]) {
  const reviewed: Array<ReviewedFile> = []
  for (const previous of entries) {
    const permission = yield* Effect.tryPromise({
      try: () => previous.handle.requestPermission({ mode: "read" }),
      catch: (cause) => new LibraryStorageError({ cause }),
    })
    if (permission !== "granted")
      return yield* new LibraryStorageError({ cause: new DOMException("Read access was not granted. Allow access or reconnect the file.", "NotAllowedError") })
    const { file, current } = yield* inspectHandle(previous.handle)
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
