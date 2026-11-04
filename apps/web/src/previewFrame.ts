import type { Cause } from "effect"
import { Effect, Queue, Redacted, Schema, Stream } from "effect"
import type { Update } from "foldkit"
import { Command, Mount, Runtime, Subscription } from "foldkit"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as v from "valibot"
import { privateValue } from "./privateValue.ts"
import { ParentMessage } from "./preview/protocol.ts"
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

type Content =
  | { readonly kind: "empty" }
  | { readonly kind: "text"; readonly text: string; readonly truncated: boolean }
  | { readonly kind: "image" | "audio" | "video"; readonly url: string }

const Model = Schema.Struct({ content: privateValue<Content>() })

type Model = typeof Model.Type

const Message = defineMessageUnion({
  ChangedContent: { content: privateValue<Content>() },
  Loaded: {},
  Failed: {},
  CompletedPreviewReply: {},
})

type Message = typeof Message.Type

const PreviewReply = Command.define("PreviewReply", {
  args: { type: Schema.Literals(["shown", "failed"]) },
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
    Loaded: () => ({ model, commands: [PreviewReply({ type: "shown" })] }),
    Failed: () => ({ model, commands: [PreviewReply({ type: "failed" })] }),
    CompletedPreviewReply: () => ({ model }),
  })

const subscriptions = Subscription.make<Model, Message>()((entry) => ({
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
                let generation = 0
                let active = true

                const clear = () => {
                  generation++

                  if (currentUrl !== undefined) {
                    URL.revokeObjectURL(currentUrl)
                  }

                  currentUrl = undefined
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

                  const { kind, blob } = parsed.output
                  clear()
                  const current = generation

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
