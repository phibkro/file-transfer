import { Dialog } from "@foldkit/ui"
import { Effect, Option, Queue, Redacted, Schema, Stream } from "effect"
import { Mount, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineView } from "foldkit/submodel"
import * as v from "valibot"
import { privateValue } from "../privateValue.ts"
import { sniff, sniffLength } from "../sniff.ts"
import type { ClearMessage, ShowMessage } from "../previewFrame.ts"
import { FrameReply } from "./protocol.ts"

export interface Input {
  readonly file: Blob
  readonly name: string
}

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  input: privateValue<Input | undefined>(),
  generation: Schema.Int,
  status: Schema.String,
  shown: Schema.Boolean,
})

export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  RequestedOpen: { input: privateValue<Input>() },
  GotDialogMessage: { message: Dialog.Message },
  ChangedStatus: { generation: Schema.Int, status: Schema.String, shown: Schema.Boolean },
})

export type Message = typeof Message.Type

const liftDialog = (message: Dialog.Message): Message => Message.GotDialogMessage({ message })

const foldOut =
  (out: Dialog.OutMessage) =>
  (model: Model): Update.Return<Model, Message> =>
    out._tag === "Closed" ? { model: { ...model, input: Redacted.make(undefined), generation: model.generation + 1, shown: false } } : { model }

const dialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.dialog),
  write: (model: Model, child: Dialog.Model): Model => ({ ...model, dialog: child }),
  toParentMessage: liftDialog,
  foldOutMessage: foldOut,
})

const openDialog = Update.foldChildStep({
  update: Dialog.open,
  read: (model: Model) => Option.some(model.dialog),
  write: (model: Model, child: Dialog.Model): Model => ({ ...model, dialog: child }),
  toParentMessage: liftDialog,
  foldOutMessage: foldOut,
})

export const init = (): Update.Return<Model, Message> => ({
  model: { dialog: Dialog.init({ id: "file-preview" }), input: Redacted.make(undefined), generation: 0, status: "", shown: false },
})

export const open = (model: Model, input: Redacted.Redacted<Input>): Update.Return<Model, Message> =>
  openDialog({ ...model, input, generation: model.generation + 1, status: "Loading the preview.", shown: false })

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match(message, {
    RequestedOpen: ({ input }) => open(model, input),
    GotDialogMessage: ({ message: child }) => dialog(model, child),
    ChangedStatus: ({ generation, status, shown }) => (generation === model.generation ? { model: { ...model, status, shown } } : { model }),
  })

// The mount owns only the message channel and its lifetime. Rendering remains Foldkit's.
const PreviewChannel = Mount.defineStream("PreviewChannel", {
  args: { input: privateValue<Input>(), generation: Schema.Int },
  messages: [Message.ChangedStatus],
  execute: ({ element, input, generation }) =>
    Stream.callback<typeof Message.ChangedStatus.Type>((queue) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const frame = element instanceof HTMLIFrameElement ? element : undefined
            let active = true
            let ready = false
            let show: ShowMessage | undefined

            const send = () => {
              if (active && ready && show !== undefined) {
                frame?.contentWindow?.postMessage(show, "*")
              }
            }

            const status = (text: string, shown: boolean) => {
              if (active) {
                Queue.offerUnsafe(queue, Message.ChangedStatus({ generation, status: text, shown }))
              }
            }

            const listener = (event: MessageEvent<unknown>) => {
              if (event.source !== frame?.contentWindow) {
                return
              }

              const reply = v.safeParse(FrameReply, event.data)

              if (!reply.success) {
                return
              }

              if (reply.output.type === "ready") {
                ready = true
                clearTimeout(timeout)
                send()
              } else if (reply.output.type === "shown") {
                status("", true)
              } else if (show !== undefined) {
                status(`This browser cannot show this ${show.kind} file. Save it to open it with another app.`, false)
              }
            }

            window.addEventListener("message", listener)

            const timeout = setTimeout(() => {
              status("The preview could not start in this browser. Save the file to open it.", false)
            }, 10_000)

            const { file } = Redacted.value(input)
            void file
              .slice(0, sniffLength)
              .arrayBuffer()
              .then((buffer) => {
                if (!active) {
                  return null
                }

                const result = sniff(new Uint8Array(buffer), file.size <= sniffLength)

                if (result === undefined) {
                  clearTimeout(timeout)
                  status("There is no preview for this kind of file. Images, audio, video and text can be previewed.", false)

                  return null
                }

                show = { type: "show", kind: result.kind, blob: new Blob([file], { type: result.mediaType }) }
                send()

                return null
              })
              .catch(() => {
                status("The preview could not start in this browser. Save the file to open it.", false)
              })

            return () => {
              active = false
              clearTimeout(timeout)
              window.removeEventListener("message", listener)
              const clear: ClearMessage = { type: "clear" }
              frame?.contentWindow?.postMessage(clear, "*")
            }
          }),
          (release) => Effect.sync(release),
        )

        return yield* Effect.never
      }),
    ),
})

export const view = defineView<Model, Message>((model, h) => {
  const input = Redacted.value(model.input)

  return h.submodel({
    slotId: "preview-dialog",
    model: model.dialog,
    view: Dialog.view,
    toParentMessage: liftDialog,
    viewInputs: {
      toView: (render) =>
        render.isVisible
          ? h.div(
              [],
              [
                h.div([...render.backdrop, h.Class("dialog-backdrop")]),
                h.dialog(
                  [...render.dialog, h.Class("preview-dialog")],
                  [
                    h.div(
                      [...render.panel],
                      [
                        h.div(
                          [h.Class("preview-bar")],
                          [h.h2([...render.title, h.Class("preview-heading")], [input?.name ?? "Preview"]), h.button([...render.closeButton], ["Close"])],
                        ),
                        h.p([h.Class("preview-message"), h.Role("status")], [model.status]),
                        input === undefined
                          ? null
                          : h.keyed("iframe")(
                              String(model.generation),
                              [
                                h.Class("preview-frame"),
                                h.Sandbox("allow-scripts"),
                                h.Title("Preview"),
                                h.Referrerpolicy("no-referrer"),
                                h.Src("/preview.html"),
                                h.Hidden(!model.shown),
                                h.OnMount(PreviewChannel({ input: Redacted.make(input), generation: model.generation })),
                              ],
                              [],
                            ),
                      ],
                    ),
                  ],
                ),
              ],
            )
          : null,
    },
  })
})
