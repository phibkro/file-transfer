// oxlint-effect-plugin ignore-file:
// reason: DOM glue inside the sandboxed preview frame; plain browser APIs, no services to compose
/**
 * The inside of the preview frame (preview.html). It runs with an opaque origin (the frame's `sandbox` attribute and
 * the page's `sandbox` header), so a hostile file rendered here cannot read the app's storage or link secrets. It takes
 * one message type from its parent, renders only the kinds on sniff.ts's allowlist, and reports whether the browser
 * could decode the file. Text is shown through `textContent`, never parsed as markup.
 */
import type { PreviewKind } from "./sniff.ts"
import { textPreviewLength } from "./sniff.ts"

export interface ShowMessage {
  readonly type: "show"
  readonly kind: PreviewKind
  readonly blob: Blob
}

export interface ClearMessage {
  readonly type: "clear"
}

export interface FrameMessage {
  readonly type: "ready" | "shown" | "failed"
}

const kinds = new Set<string>(["image", "video", "audio", "text"])

const isShowMessage = (data: unknown): data is ShowMessage =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  data.type === "show" &&
  "kind" in data &&
  typeof data.kind === "string" &&
  kinds.has(data.kind) &&
  "blob" in data &&
  data.blob instanceof Blob

const isClearMessage = (data: unknown): data is ClearMessage => typeof data === "object" && data !== null && "type" in data && data.type === "clear"

const tell = (message: FrameMessage) => {
  // The parent's origin is the app's; this frame's is opaque, so "*" is the only target that reaches it. Nothing
  // secret is sent: only whether a preview rendered.
  window.parent.postMessage(message, "*")
}

let currentUrl: string | undefined

/** Stops any playing media and forgets the file. */
const clear = () => {
  document.body.replaceChildren()

  if (currentUrl !== undefined) {
    URL.revokeObjectURL(currentUrl)
    currentUrl = undefined
  }
}

const show = async ({ kind, blob }: ShowMessage) => {
  clear()

  if (kind === "text") {
    const text = await blob.slice(0, textPreviewLength).text()
    const nodes: HTMLElement[] = [Object.assign(document.createElement("pre"), { textContent: text })]

    if (blob.size > textPreviewLength) {
      nodes.push(Object.assign(document.createElement("p"), { className: "note", textContent: "Only the beginning of the file is shown." }))
    }

    document.body.replaceChildren(...nodes)
    tell({ type: "shown" })

    return
  }

  const url = URL.createObjectURL(blob)
  currentUrl = url

  if (kind === "image") {
    const image = document.createElement("img")
    image.alt = ""
    image.addEventListener("load", () => {
      tell({ type: "shown" })
    })
    image.addEventListener("error", () => {
      tell({ type: "failed" })
    })
    image.src = url
    document.body.replaceChildren(image)

    return
  }

  const media = document.createElement(kind)
  media.controls = true
  media.preload = "metadata"
  media.addEventListener("loadedmetadata", () => {
    tell({ type: "shown" })
  })
  media.addEventListener("error", () => {
    tell({ type: "failed" })
  })
  media.src = url
  document.body.replaceChildren(media)
}

// Refuse to run with a real origin: then this page would share the app's storage.
if (window.origin === "null") {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) {
      return
    }

    if (isClearMessage(event.data)) {
      clear()

      return
    }

    if (!isShowMessage(event.data)) {
      return
    }

    void show(event.data).catch(() => {
      tell({ type: "failed" })
    })
  })
  tell({ type: "ready" })
}
