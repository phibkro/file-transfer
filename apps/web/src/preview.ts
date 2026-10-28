// oxlint-effect-plugin ignore-file:
// reason: browser glue over a dialog, an iframe and postMessage; moves into apps/web's view layer with the rest of the MVP orchestration (docs/plan.md)
/**
 * Previews of files, for the sender before sealing and for the recipient once files have verified. The file's first
 * bytes decide whether and how it can be previewed (sniff.ts); the preview itself renders in a sandboxed frame with an
 * opaque origin (preview.html, previewFrame.ts), never on the app's own origin (docs/parcel.md, manifest validation;
 * docs/decisions/0018-previews-and-renaming.md). Everything stays in this browser: the frame gets the file as a Blob
 * through `postMessage`, and nothing is fetched.
 */
import type { ClearMessage, FrameMessage, ShowMessage } from "./previewFrame.ts"
import { sniff, sniffLength } from "./sniff.ts"
import type { Sniffed } from "./sniff.ts"
import { element } from "./view.ts"

const framePath = "/preview.html"

/** How long the frame may take to load before the preview gives up. */
const frameStartMilliseconds = 10_000

const pause = async (milliseconds: number) => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

interface Previewer {
  readonly dialog: HTMLDialogElement
  readonly heading: HTMLElement
  readonly message: HTMLElement
  readonly frame: HTMLIFrameElement
  readonly ready: Promise<void>
}

let previewer: Previewer | undefined

const isFrameMessage = (data: unknown): data is FrameMessage =>
  typeof data === "object" && data !== null && "type" in data && (data.type === "ready" || data.type === "shown" || data.type === "failed")

/** Messages from the preview frame, after `ready`; `ready` itself resolves the promise. */
const frameListeners = new Set<(message: FrameMessage) => void>()

const createPreviewer = (): Previewer => {
  const heading = element("h2", { class: "preview-heading" })
  const close = element("button", { type: "button" }, ["Close"])
  const message = element("p", { class: "preview-message", role: "status" })
  // No `allow-same-origin`: the frame's origin is opaque. No other permissions either.
  const frame = element("iframe", { class: "preview-frame", sandbox: "allow-scripts", title: "Preview", referrerpolicy: "no-referrer", src: framePath })

  const dialog = element("dialog", { class: "preview-dialog", "aria-labelledby": "preview-heading" }, [
    element("div", { class: "preview-bar" }, [heading, close]),
    message,
    frame,
  ])

  heading.id = "preview-heading"

  const ready = new Promise<void>((resolve) => {
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || !isFrameMessage(event.data)) {
        return
      }

      if (event.data.type === "ready") {
        resolve()

        return
      }

      for (const listener of frameListeners) {
        listener(event.data)
      }
    })
  })

  close.addEventListener("click", () => {
    dialog.close()
  })
  dialog.addEventListener("close", () => {
    const clear: ClearMessage = { type: "clear" }
    frame.contentWindow?.postMessage(clear, "*")
  })
  document.body.append(dialog)

  return { dialog, heading, message, frame, ready }
}

const kindLabel = (sniffed: Sniffed): string => (sniffed.kind === "text" ? "text" : sniffed.kind)

/** Opens the preview dialog for `file`, or explains why there is no preview. */
export const openPreview = async (file: Blob, name: string): Promise<void> => {
  previewer ??= createPreviewer()
  const { dialog, heading, message, frame, ready } = previewer
  heading.textContent = name
  message.textContent = ""
  frame.hidden = true

  if (!dialog.open) {
    dialog.showModal()
  }

  const sample = new Uint8Array(await file.slice(0, sniffLength).arrayBuffer())
  const sniffed = sniff(sample, file.size <= sniffLength)

  if (sniffed === undefined) {
    message.textContent = "There is no preview for this kind of file. Images, audio, video and text can be previewed."

    return
  }

  message.textContent = "Loading the preview."

  if (!(await Promise.race([ready.then(() => true), pause(frameStartMilliseconds).then(() => false)]))) {
    message.textContent = "The preview could not start in this browser. Save the file to open it."

    return
  }

  frameListeners.clear()
  frameListeners.add((reply) => {
    if (reply.type === "shown") {
      message.textContent = ""
      frame.hidden = false
    } else {
      message.textContent = `This browser cannot show this ${kindLabel(sniffed)} file. Save it to open it with another app.`
      frame.hidden = true
    }
  })

  // A Blob of the sniffed type, so nothing in the frame guesses a type from the name or the manifest.
  const show: ShowMessage = { type: "show", kind: sniffed.kind, blob: new Blob([file], { type: sniffed.mediaType }) }
  // The frame's origin is opaque, so "*" is the only target that reaches it; `frame` is ours and never navigates.
  frame.contentWindow?.postMessage(show, "*")
}

/** A "Preview" button for one file; `file` and `name` are read when it is pressed. */
export const previewButton = (file: () => Blob | undefined, name: () => string): HTMLButtonElement => {
  const button = element("button", { type: "button", class: "preview", "aria-label": `Preview ${name()}` }, ["Preview"])
  button.addEventListener("click", () => {
    const blob = file()

    if (blob !== undefined) {
      void openPreview(blob, name())
    }
  })

  return button
}
