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
}

const transfersDirectory = "transfers"

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

      await writable.write({ type: "write", position, data: bytes })
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
    },
  }
}
