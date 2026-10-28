// oxlint-effect-plugin ignore-file:
// reason: the origin private file system is a Promise API; this MVP adapter becomes the OPFS tier of libraries/sink (docs/plan.md)
/**
 * Provisional output in the origin private file system: one file per manifest entry under `transfers/<room>`,
 * written at arbitrary positions through `createWritable`. A writable stages its writes and publishes them only on
 * `close`, so nothing is visible until the whole parcel verifies; `discard` aborts the writables and removes the
 * directory (docs/parcel.md, receiver rule 5).
 */

export interface ParcelStorage {
  readonly write: (fileIndex: number, position: number, bytes: Uint8Array<ArrayBuffer>) => Promise<void>
  /** Publishes every file and returns them, in manifest order. */
  readonly commit: () => Promise<readonly File[]>
  /** Throws away everything written. */
  readonly discard: () => Promise<void>
  /** Deletes the committed files from this browser, after the person has saved them. */
  readonly remove: () => Promise<void>
}

const transfersDirectory = "transfers"

/** The Web Lock a tab holds while its transfer's files exist, so other tabs' sweeps leave them alone. */
const lockName = (roomIdentifier: string) => `file-transfer:transfer:${roomIdentifier}`

/** Waits until the function handed over is called. */
const waitForRelease = async (handOver: (release: () => void) => void) => {
  await new Promise<void>((resolve) => {
    handOver(() => {
      resolve()
    })
  })
}

/** Holds the lock until the returned function is called or the tab goes away. */
const holdLock = async (roomIdentifier: string): Promise<() => void> =>
  await new Promise<() => void>((resolve) => {
    void navigator.locks.request(lockName(roomIdentifier), async () => {
      await waitForRelease(resolve)
    })
  })

/**
 * Deletes received files that no open tab is using: transfers interrupted by a closed or crashed tab, and finished
 * ones whose tab is gone. Received files are decrypted, so they should not outlive the page that received them.
 * Run on every page load, before a transfer opens its own storage.
 */
export const sweepStaleTransfers = async (): Promise<void> => {
  try {
    const root = await navigator.storage.getDirectory()
    const transfers = await root.getDirectoryHandle(transfersDirectory, { create: true })
    const snapshot = await navigator.locks.query()
    const held = new Set((snapshot.held ?? []).map((lock) => lock.name))
    const stale: string[] = []

    for await (const name of transfers.keys()) {
      if (!held.has(lockName(name))) {
        stale.push(name)
      }
    }

    await Promise.all(
      stale.map(async (name) => {
        await removeQuietly(transfers, name)
      }),
    )
  } catch {
    // No origin-private file system here (private browsing in some browsers): nothing was stored either.
  }
}

/** What this site keeps in this browser, for the storage panel. */
export interface StorageUse {
  /** Bytes of received files that are complete, across every transfer still stored. */
  readonly receivedBytes: number
  /** Transfers whose files an open page (this one or another tab) is still using. */
  readonly inUse: number
  /** Transfers no open page is using; the next page load or Clear deletes them. */
  readonly stale: number
  /** The browser's own estimate for this site, which also counts writes not yet committed. */
  readonly usage: number | undefined
  readonly quota: number | undefined
}

const fileSize = async (handle: FileSystemHandle): Promise<number> => {
  try {
    if (handle.kind !== "file") {
      return 0
    }

    // SAFETY: a directory's handles of kind "file" are file handles.
    const file = await (handle as FileSystemFileHandle).getFile()

    return file.size
  } catch {
    return 0
  }
}

const directorySize = async (directory: FileSystemDirectoryHandle): Promise<number> => {
  let total = 0

  for await (const handle of directory.values()) {
    total += await fileSize(handle)
  }

  return total
}

export const storageUse = async (): Promise<StorageUse> => {
  let receivedBytes = 0
  let inUse = 0
  let stale = 0

  try {
    const root = await navigator.storage.getDirectory()
    const transfers = await root.getDirectoryHandle(transfersDirectory, { create: true })
    const snapshot = await navigator.locks.query()
    const held = new Set((snapshot.held ?? []).map((lock) => lock.name))

    for await (const handle of transfers.values()) {
      if (handle.kind === "directory") {
        // SAFETY: checked kind "directory" just above.
        receivedBytes += await directorySize(handle)

        if (held.has(lockName(handle.name))) {
          inUse++
        } else {
          stale++
        }
      }
    }
  } catch {
    // No origin-private file system here: nothing is stored either.
  }

  try {
    const { usage, quota } = await navigator.storage.estimate()

    return { receivedBytes, inUse, stale, usage, quota }
  } catch {
    return { receivedBytes, inUse, stale, usage: undefined, quota: undefined }
  }
}

/**
 * Bytes this site may still store here, or undefined when the browser does not say. Private windows get a small quota
 * (about 2.1 GB in headless Chromium), so a large parcel can fail partway through unless this is checked first.
 */
export const availableStorage = async (): Promise<number | undefined> => {
  try {
    const { quota, usage } = await navigator.storage.estimate()

    return quota === undefined ? undefined : Math.max(0, quota - (usage ?? 0))
  } catch {
    return undefined
  }
}

/** Removes an entry, ignoring one that is already gone. */
const removeQuietly = async (directory: FileSystemDirectoryHandle, name: string) => {
  try {
    await directory.removeEntry(name, { recursive: true })
  } catch {
    // Already gone, or held open by another tab: nothing to keep either way.
  }
}

export const openStorage = async (roomIdentifier: string, fileCount: number): Promise<ParcelStorage> => {
  const releaseLock = await holdLock(roomIdentifier)
  const root = await navigator.storage.getDirectory()
  const transfers = await root.getDirectoryHandle(transfersDirectory, { create: true })
  await removeQuietly(transfers, roomIdentifier)
  const directory = await transfers.getDirectoryHandle(roomIdentifier, { create: true })
  const handles: FileSystemFileHandle[] = []
  const writables: FileSystemWritableFileStream[] = []

  for (let index = 0; index < fileCount; index++) {
    // Files are stored by position: manifest names may hold folders and characters this file system refuses.
    const handle = await directory.getFileHandle(String(index), { create: true })
    handles.push(handle)
    writables.push(await handle.createWritable({ keepExistingData: false }))
  }

  return {
    write: async (fileIndex, position, bytes) => {
      const writable = writables[fileIndex]

      if (writable === undefined) {
        throw new RangeError(`no file ${fileIndex}`)
      }

      // WebKit writes a view's whole underlying buffer rather than the view's own bytes (spike 0002: files that start
      // or end inside a record came back wrong in Playwright's WebKit), so a partial view is copied first.
      const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
      await writable.write({ type: "write", position, data })
    },
    commit: async () => {
      for (const writable of writables) {
        await writable.close()
      }

      return await Promise.all(handles.map(async (handle) => await handle.getFile()))
    },
    discard: async () => {
      await Promise.allSettled(
        writables.map(async (writable) => {
          await writable.abort()
        }),
      )
      await removeQuietly(transfers, roomIdentifier)
      releaseLock()
    },
    remove: async () => {
      await removeQuietly(transfers, roomIdentifier)
      releaseLock()
    },
  }
}
