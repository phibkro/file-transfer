/** Browser-owned saving of already verified files. File names have passed the parcel name profile. */
import type { RecipientSession } from "../recipient.ts"

export interface Download {
  readonly name: string
  readonly file: File
  readonly url: string
}

type DirectoryPicker = (options: { readonly mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>

/** A native picker cannot be dismissed, so cancellation detaches its eventual result. */
const chooseDirectory = async (picker: DirectoryPicker, signal: AbortSignal): Promise<FileSystemDirectoryHandle | undefined> => {
  const { promise, resolve, reject } = Promise.withResolvers<FileSystemDirectoryHandle | undefined>()

  if (signal.aborted) {
    resolve(undefined)

    return await promise
  }

  const abort = () => {
    resolve(undefined)
  }

  signal.addEventListener("abort", abort, { once: true })

  void (async () => {
    try {
      resolve(await picker.call(window, { mode: "readwrite" }))
    } catch (error) {
      reject(error)
    } finally {
      signal.removeEventListener("abort", abort)
    }
  })()

  return await promise
}

/** Save all files to a chosen folder, or start individual downloads where no picker is available. */
export const saveAll = async (files: readonly Download[], signal: AbortSignal): Promise<"saved" | "cancelled" | "failed"> => {
  try {
    if (!("showDirectoryPicker" in window)) {
      for (const file of files) {
        if (signal.aborted) {
          return "cancelled"
        }

        const link = document.createElement("a")
        link.href = file.url
        link.download = file.name.split("/").join("_")
        link.click()
        const pause = Promise.withResolvers<undefined>()

        const timer = setTimeout(() => {
          pause.resolve(undefined)
        }, 400)

        const abort = () => {
          clearTimeout(timer)
          pause.resolve(undefined)
        }

        signal.addEventListener("abort", abort, { once: true })
        await pause.promise
        signal.removeEventListener("abort", abort)
      }

      return signal.aborted ? "cancelled" : "saved"
    }

    // SAFETY: the property check above establishes the browser exposes its directory picker.
    const picker = window.showDirectoryPicker as DirectoryPicker
    const root = await chooseDirectory(picker, signal)

    if (root === undefined || signal.aborted) {
      return "cancelled"
    }

    for (const file of files) {
      if (signal.aborted) {
        return "cancelled"
      }

      const segments = file.name.split("/")
      const name = segments.pop() ?? file.name
      let directory = root

      for (const segment of segments) {
        directory = await directory.getDirectoryHandle(segment, { create: true })

        if (signal.aborted) {
          return "cancelled"
        }
      }

      const handle = await directory.getFileHandle(name, { create: true })

      if (signal.aborted) {
        return "cancelled"
      }

      const writable = await handle.createWritable({ keepExistingData: false })
      await file.file.stream().pipeTo(writable, { signal })
    }

    return "saved"
  } catch (error) {
    return signal.aborted || (error instanceof DOMException && error.name === "AbortError") ? "cancelled" : "failed"
  }
}

/** The recipient owns download work as well as its transfer session. */
export const ownDownloads = (session: RecipientSession) => {
  const controller = new AbortController()
  let pending: Promise<"saved" | "cancelled" | "failed"> | undefined

  return {
    ...session,
    saveAll: async () => {
      if (controller.signal.aborted) {
        return "cancelled" as const
      }

      if (pending !== undefined) {
        return await pending
      }

      const files = session
        .currentSnapshot()
        .files.flatMap((entry) => (entry.file === undefined || entry.url === undefined ? [] : [{ name: entry.name, file: entry.file, url: entry.url }]))

      pending = saveAll(files, controller.signal)
        .then((result) => {
          if (result === "saved" && !controller.signal.aborted) {
            session.markSaved()
          }

          return result
        })
        .finally(() => {
          pending = undefined
        })

      return await pending
    },
    dispose: async () => {
      controller.abort()

      try {
        await session.dispose()
      } finally {
        await pending
      }
    },
  }
}
