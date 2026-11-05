import { Button } from "@foldkit/ui"
import type { Appearance } from "./appearance.ts"
import type { Cause } from "effect"
import { Effect, Option, Queue, Redacted, Schema, Stream } from "effect"
import type { Update } from "foldkit"
import { Command, Mount, Runtime, Subscription } from "foldkit"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { streamFromEventFilterMap } from "foldkit/dom"
import * as v from "valibot"
import { AnnotationMode, getDocument, VerbosityLevel } from "pdfjs-dist"
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist"
import * as pdfWorker from "pdfjs-dist/build/pdf.worker.mjs"
import { privateValue } from "./privateValue.ts"
import { ParentMessage, frameReplyKinds } from "./preview/protocol.ts"
import type { FrameReply } from "./preview/protocol.ts"
import { pdfResource } from "./preview/pdfResources.ts"
import type { PreviewKind } from "./sniff.ts"
import { textPreviewLength } from "./sniff.ts"

export interface ShowMessage {
  readonly type: "show"
  readonly kind: PreviewKind
  readonly blob: Blob
  readonly appearance: Appearance
}

export interface ClearMessage {
  readonly type: "clear"
}

export type FrameMessage = v.InferOutput<typeof FrameReply>

type Content =
  | { readonly kind: "empty" }
  | { readonly kind: "pdf"; readonly document: PDFDocumentProxy; readonly page: number; readonly pages: number; readonly generation: number }
  | { readonly kind: "text"; readonly text: string; readonly truncated: boolean }
  | { readonly kind: "image" | "audio" | "video"; readonly url: string }

const Model = Schema.Struct({ content: privateValue<Content>() })

type Model = typeof Model.Type

const Message = defineMessageUnion({
  ChangedContent: { content: privateValue<Content>() },
  Loaded: {},
  LoadedPdf: { page: Schema.Int, pages: Schema.Int, generation: Schema.Int },
  RequestedPage: { page: Schema.Int },
  FailedPdf: { page: Schema.Int, generation: Schema.Int },
  Failed: {},
  PressedEscape: {},
  CompletedPreviewReply: {},
})

type Message = typeof Message.Type

const PreviewReply = Command.define("PreviewReply", {
  args: { type: Schema.Literals(frameReplyKinds) },
  messages: [Message.CompletedPreviewReply],
  execute: ({ type }) =>
    Effect.sync(() => {
      window.parent.postMessage({ type } satisfies FrameMessage, "*")

      return Message.CompletedPreviewReply()
    }),
})

const init = () => ({ model: { content: Redacted.make<Content>({ kind: "empty" }) } })

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match(message, {
    ChangedContent: ({ content }) => ({ model: { ...model, content } }),
    LoadedPdf: ({ page, pages, generation }) => {
      const content = Redacted.value(model.content)

      if (content.kind !== "pdf" || content.generation !== generation || content.page !== page) {
        return { model }
      }

      return { model: { ...model, content: Redacted.make({ ...content, pages }) }, commands: [PreviewReply({ type: "shown" })] }
    },
    FailedPdf: ({ page, generation }) => {
      const content = Redacted.value(model.content)

      return content.kind === "pdf" && content.page === page && content.generation === generation
        ? { model, commands: [PreviewReply({ type: "failed" })] }
        : { model }
    },
    RequestedPage: ({ page }) => {
      const content = Redacted.value(model.content)

      return content.kind === "pdf" && page >= 1 && page <= content.pages ? { model: { ...model, content: Redacted.make({ ...content, page }) } } : { model }
    },
    Loaded: () => ({ model, commands: [PreviewReply({ type: "shown" })] }),
    Failed: () => ({ model, commands: [PreviewReply({ type: "failed" })] }),
    CompletedPreviewReply: () => ({ model }),
    PressedEscape: () => ({ model, commands: [PreviewReply({ type: "close" })] }),
  })

const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  escapeKey: Subscription.persistentEntry(
    streamFromEventFilterMap({
      target: () => window,
      type: "keydown",
      filterMapEvent: (event) => {
        if (event instanceof KeyboardEvent && event.key === "Escape") {
          event.preventDefault()

          return Option.some(Message.PressedEscape())
        }

        return Option.none()
      },
    }),
  ),
  previewMessages: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.callback<typeof Message.ChangedContent.Type | typeof Message.Loaded.Type | typeof Message.Failed.Type>((queue) =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                let currentUrl: string | undefined
                let currentPdf: PDFDocumentLoadingTask | undefined
                let generation = 0
                let active = true

                const clear = () => {
                  generation++

                  if (currentUrl !== undefined) {
                    URL.revokeObjectURL(currentUrl)
                  }

                  currentUrl = undefined
                  void currentPdf?.destroy().catch(() => undefined)
                  currentPdf = undefined
                  Queue.offerUnsafe(queue, Message.ChangedContent({ content: Redacted.make({ kind: "empty" }) }))
                }

                const listener = (event: MessageEvent<unknown>) => {
                  if (event.source !== window.parent) {
                    return
                  }

                  const parsed = v.safeParse(ParentMessage, event.data)

                  if (!parsed.success) {
                    return
                  }

                  if (parsed.output.type === "clear") {
                    clear()

                    return
                  }

                  const { kind, blob, appearance } = parsed.output
                  document.documentElement.dataset.appearance = appearance
                  clear()
                  const current = generation

                  if (kind === "pdf") {
                    if (blob.size > 25 * 1024 * 1024) {
                      Queue.offerUnsafe(queue, Message.Failed())

                      return
                    }

                    void blob
                      .arrayBuffer()
                      .then((buffer): Promise<PDFDocumentProxy> | null => {
                        if (!active || generation !== current) {
                          return null
                        }

                        // The bundled worker executes locally; no worker URL or auxiliary fetch is needed.
                        Object.assign(globalThis, { pdfjsWorker: pdfWorker })
                        currentPdf = getDocument({
                          data: new Uint8Array(buffer),
                          disableFontFace: true,
                          useSystemFonts: false,
                          useWorkerFetch: false,
                          BinaryDataFactory: PdfBinaryDataFactory,
                          useWasm: false,
                          enableXfa: false,
                          verbosity: VerbosityLevel.ERRORS,
                          maxImageSize: 16_000_000,
                        })

                        return currentPdf.promise
                      })
                      .then((document) => {
                        if (active && generation === current && document !== null) {
                          Queue.offerUnsafe(
                            queue,
                            Message.ChangedContent({ content: Redacted.make({ kind, document, page: 1, pages: document.numPages, generation: current }) }),
                          )
                        }

                        return null
                      })
                      .catch(() => {
                        if (active && generation === current) {
                          Queue.offerUnsafe(queue, Message.Failed())
                        }
                      })

                    return
                  }

                  if (kind === "text") {
                    void blob
                      .slice(0, textPreviewLength)
                      .text()
                      .then((text) => {
                        if (!active || generation !== current) {
                          return null
                        }

                        Queue.offerUnsafe(queue, Message.ChangedContent({ content: Redacted.make({ kind, text, truncated: blob.size > textPreviewLength }) }))
                        Queue.offerUnsafe(queue, Message.Loaded())

                        return null
                      })
                      .catch(() => {
                        if (active && generation === current) {
                          Queue.offerUnsafe(queue, Message.Failed())
                        }
                      })

                    return
                  }

                  currentUrl = URL.createObjectURL(blob)
                  Queue.offerUnsafe(queue, Message.ChangedContent({ content: Redacted.make({ kind, url: currentUrl }) }))
                }

                window.addEventListener("message", listener)
                window.parent.postMessage({ type: "ready" } satisfies FrameMessage, "*")

                return () => {
                  active = false
                  window.removeEventListener("message", listener)
                  clear()
                }
              }),
              (release) => Effect.sync(release),
            )

            return yield* Effect.never
          }),
        ),
    },
  ),
}))

const mediaEventHandler = (queue: Queue.Queue<typeof Message.Loaded.Type | typeof Message.Failed.Type, Cause.Done>) => (event: Event) => {
  Queue.offerUnsafe(queue, event.type === "error" ? Message.Failed() : Message.Loaded())
}

const MediaEvents = Mount.defineStream("PreviewMediaEvents", {
  messages: [Message.Loaded, Message.Failed],
  execute: ({ element }) =>
    Stream.callback<typeof Message.Loaded.Type | typeof Message.Failed.Type>((queue) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const receive = mediaEventHandler(queue)

            element.addEventListener("loadedmetadata", receive)
            element.addEventListener("load", receive)
            element.addEventListener("error", receive)

            if (element instanceof HTMLImageElement && element.complete) {
              Queue.offerUnsafe(queue, element.naturalWidth > 0 ? Message.Loaded() : Message.Failed())
            } else if (element instanceof HTMLMediaElement && element.error !== null) {
              Queue.offerUnsafe(queue, Message.Failed())
            } else if (element instanceof HTMLMediaElement && element.readyState >= 1) {
              Queue.offerUnsafe(queue, Message.Loaded())
            }

            return () => {
              element.removeEventListener("loadedmetadata", receive)
              element.removeEventListener("load", receive)
              element.removeEventListener("error", receive)
            }
          }),
          (release) => Effect.sync(release),
        )

        return yield* Effect.never
      }),
    ),
})

// PDF.js calls this composition-root bridge through its Promise-based factory ABI.
class PdfBinaryDataFactory {
  private readonly read = pdfResource

  // oxlint-disable-next-line typescript/promise-function-async -- PDF.js requires this Promise-returning method.
  fetch({ kind, filename }: { readonly kind: string; readonly filename: string }): Promise<Uint8Array> {
    return Effect.runPromise(this.read(kind, filename))
  }
}

const PdfPage = Mount.defineStream("PreviewPdfPage", {
  args: { document: privateValue<PDFDocumentProxy>(), page: Schema.Int, generation: Schema.Int },
  messages: [Message.LoadedPdf, Message.FailedPdf],
  execute: ({ element, document, page, generation }) =>
    Stream.callback<typeof Message.LoadedPdf.Type | typeof Message.FailedPdf.Type>((queue) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            let active = true
            let rendering: RenderTask | undefined
            const canvas = element instanceof HTMLCanvasElement ? element : undefined

            void Redacted.value(document)
              .getPage(page)
              .then((pdfPage): Promise<void> | null => {
                if (!active || canvas === undefined) {
                  return null
                }

                const base = pdfPage.getViewport({ scale: 1 })
                const scale = Math.min(1.5, 2048 / base.width, 2048 / base.height, Math.sqrt(4_000_000 / (base.width * base.height)))
                const viewport = pdfPage.getViewport({ scale })

                canvas.width = Math.max(1, Math.floor(viewport.width))
                canvas.height = Math.max(1, Math.floor(viewport.height))
                rendering = pdfPage.render({ canvas, viewport, annotationMode: AnnotationMode.DISABLE })

                return rendering.promise
              })
              .then(() => {
                if (active) {
                  Queue.offerUnsafe(queue, Message.LoadedPdf({ page, pages: Redacted.value(document).numPages, generation }))
                }

                return null
              })
              .catch(() => {
                if (active) {
                  Queue.offerUnsafe(queue, Message.FailedPdf({ page, generation }))
                }
              })

            return () => {
              active = false
              rendering?.cancel()

              if (canvas !== undefined) {
                canvas.width = 0
                canvas.height = 0
              }
            }
          }),
          (release) => Effect.sync(release),
        )

        return yield* Effect.never
      }),
    ),
})

const view = (model: Model, h: HtmlBuilder<Message>) => {
  const content = Redacted.value(model.content)

  return h.div(
    [h.Class("preview-content")],
    [
      content.kind === "text"
        ? h.div(
            [h.Class("preview-text")],
            [h.pre([], [content.text]), content.truncated ? h.p([h.Class("note")], ["Only the beginning of the file is shown."]) : null],
          )
        : null,
      content.kind === "pdf"
        ? h.div(
            [h.Class("preview-pdf")],
            [
              h.div(
                [h.Class("preview-pdf-controls")],
                [
                  Button.view(
                    {
                      onClick: Message.RequestedPage({ page: content.page - 1 }),
                      isDisabled: content.page <= 1,
                      toView: (attributes) => h.button([...attributes.button, h.Class("button")], ["Previous"]),
                    },
                    h,
                  ),
                  h.span([h.Role("status")], [content.pages > 0 ? `Page ${content.page} of ${content.pages}` : "Loading PDF"]),
                  Button.view(
                    {
                      onClick: Message.RequestedPage({ page: content.page + 1 }),
                      isDisabled: content.page >= content.pages,
                      toView: (attributes) => h.button([...attributes.button, h.Class("button")], ["Next"]),
                    },
                    h,
                  ),
                ],
              ),
              h.keyed("canvas")(`${content.generation}:${content.page}`, [
                h.AriaLabel(`PDF page ${content.page}`),
                h.OnMount(PdfPage({ document: Redacted.make(content.document), page: content.page, generation: content.generation })),
              ]),
            ],
          )
        : null,
      content.kind === "image" ? h.img([h.Src(content.url), h.Alt(""), h.OnMount(MediaEvents())]) : null,
      content.kind === "audio" ? h.audio([h.Src(content.url), h.Controls(true), h.Preload("metadata"), h.OnMount(MediaEvents())]) : null,
      content.kind === "video" ? h.video([h.Src(content.url), h.Controls(true), h.Preload("metadata"), h.OnMount(MediaEvents())]) : null,
    ],
  )
}

// Both the iframe sandbox and the response header make the origin opaque.
// Refuse to render when that boundary is absent.
if (window.origin === "null") {
  Runtime.run(
    Runtime.makeElement({ Model, init, update, view, subscriptions, container: document.querySelector<HTMLElement>("#preview-app"), devTools: false }),
  )
}
