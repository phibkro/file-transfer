// oxlint-effect-plugin ignore-file:
// reason: browser glue over the directory picker, streams and downloads; moves into libraries/sink with the rest of the MVP orchestration (docs/plan.md)
/**
 * "Save all files" for the recipient. Where the browser offers a folder picker (Chromium on desktop and Android), the
 * files are streamed from the origin-private file system into a folder the person chooses, keeping the parcel's
 * folder structure; nothing passes through memory as a whole. Elsewhere (Firefox, Safari) each file's download link is
 * activated in turn, and the browser may ask once to allow several downloads.
 */
import { element } from "./view.ts"

export interface ReceivedFile {
  /** The name from the manifest, with `/` between folders. */
  readonly name: string
  readonly file: File
  /** The file's download link, already on the page. */
  readonly link: HTMLAnchorElement
}

type DirectoryPicker = (options: { readonly mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>

/** The folder picker, where the browser has one. */
const directoryPicker = (): DirectoryPicker | undefined => {
  if (!("showDirectoryPicker" in window)) {
    return undefined
  }

  // SAFETY: the `in` check above found the property; the DOM types this project builds with do not declare it.
  const picker = window.showDirectoryPicker as DirectoryPicker

  return picker.bind(window)
}

/** Writes each file under `root`, creating the folders in its name; names already passed the parcel's name rules. */
const saveIntoFolder = async (root: FileSystemDirectoryHandle, files: readonly ReceivedFile[], progress: (saved: number) => void) => {
  for (const [index, received] of files.entries()) {
    const segments = received.name.split("/")
    const fileName = segments.pop() ?? received.name
    let folder = root

    for (const segment of segments) {
      folder = await folder.getDirectoryHandle(segment, { create: true })
    }

    const handle = await folder.getFileHandle(fileName, { create: true })
    const writable = await handle.createWritable({ keepExistingData: false })
    await received.file.stream().pipeTo(writable)
    progress(index + 1)
  }
}

const pause = async (milliseconds: number) => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

/** Activates each download link in turn; a short pause lets the browser register each download. */
const downloadEach = async (files: readonly ReceivedFile[]) => {
  for (const received of files) {
    received.link.click()
    await pause(400)
  }
}

/** The "Save all files" button and its status line, for two or more received files. */
export const saveAllControl = (received: () => readonly ReceivedFile[], onSaved: () => void): HTMLElement => {
  const picker = directoryPicker()
  const button = element("button", { type: "button", class: "primary" }, [picker === undefined ? "Save all files" : "Save all files to a folder"])
  const status = element("p", { class: "save-all-status", role: "status" })

  const saveAll = async () => {
    button.disabled = true
    const files = received()

    try {
      if (picker === undefined) {
        await downloadEach(files)
        status.textContent = "Downloads started. If the browser asks, allow it to download several files."
      } else {
        const root = await picker({ mode: "readwrite" })
        await saveIntoFolder(root, files, (saved) => {
          status.textContent = `Saved ${saved} of ${files.length} files.`
        })
        status.textContent = `Saved all ${files.length} files to the folder you chose.`
      }

      onSaved()
    } catch (error) {
      // Closing the folder picker is a choice, not an error; anything else is reported.
      status.textContent = error instanceof DOMException && error.name === "AbortError" ? "" : "Some files could not be saved. Use the links above instead."
    } finally {
      button.disabled = false
    }
  }

  button.addEventListener("click", () => {
    void saveAll()
  })

  return element("div", { class: "save-all" }, [button, status])
}
