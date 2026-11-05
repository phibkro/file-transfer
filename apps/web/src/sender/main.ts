import { Button, FileDrop, Progress, Tabs } from "@foldkit/ui"
import { Effect, Option, Queue, Redacted, Schema, Stream } from "effect"
import { Command, Subscription, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineView } from "foldkit/submodel"
import { privateValue } from "../privateValue.ts"
import { icon } from "../ui/icon.ts"
import * as Receive from "../ui/receive.ts"
import { securityRouter } from "../routes.ts"
import { addToSelection, removeFromSelection } from "../selection.ts"
import { estimatedRelayedBytes, fetchServerLimits } from "../serverLimits.ts"
import { describeFailure, formatSize } from "../view.ts"
import { openOtherTransfer, startTransfer } from "../sender.ts"
import * as Name from "../ui/name.ts"
import * as Share from "../ui/share.ts"
import * as Preview from "../preview/main.ts"

interface Entry {
  readonly file: File
  readonly name: string
  readonly key: number
  readonly editor: Name.Model
}

interface Rejection {
  readonly name: string
  readonly reason: string
}

const Entries = privateValue<readonly Entry[]>()
const Rejections = privateValue<readonly Rejection[]>()
const PrivateDrop = privateValue<FileDrop.Message>()
const PrivateName = privateValue<Name.Message>()
const PrivatePreview = privateValue<Preview.Message>()
const PrivateLink = privateValue<string>()

export const Model = Schema.Struct({
  fileDrop: FileDrop.Model,
  tabs: Tabs.Model,
  mode: Schema.Literals(["send", "receive"]),
  receive: Receive.Model,
  origin: Schema.String,
  entries: Entries,
  rejections: Rejections,
  nextKey: Schema.Int,
  limits: Schema.Option(Schema.Struct({ relayedBytesPerRoom: Schema.Finite, roomsPerAddressPerHour: Schema.Finite })),
  limitsLoaded: Schema.Boolean,
  autoSeal: Schema.Boolean,
  sealed: Schema.Boolean,
  active: Schema.Boolean,
  status: privateValue<string>(),
  phase: Schema.String,
  done: Schema.Finite,
  total: Schema.Finite,
  share: Share.Model,
  hasLink: Schema.Boolean,
  preview: Preview.Model,
})

export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ReceivedPrivateFileDropMessage: { message: PrivateDrop },
  ReceivedPrivateNameMessage: { key: Schema.Int, message: PrivateName },
  GotShareMessage: { message: Share.Message },
  GotTabsMessage: { message: Tabs.Message },
  GotReceiveMessage: { message: Receive.Message },
  ReceivedPrivatePreviewMessage: { message: PrivatePreview },
  LoadedLimits: { limits: Schema.Option(Schema.Struct({ relayedBytesPerRoom: Schema.Finite, roomsPerAddressPerHour: Schema.Finite })) },
  RequestedRemove: { key: Schema.Int },
  RequestedPreview: { key: Schema.Int },
  RequestedSeal: {},
  RequestedCancel: {},
  RequestedOther: {},
  ReceivedStatus: { text: privateValue<string>() },
  ReceivedProgress: { phase: Schema.String, done: Schema.Finite, total: Schema.Finite },
  ReceivedLink: { link: PrivateLink },
  FailedTransfer: { reason: Schema.String, detail: privateValue<string | undefined>() },
  DismissedRejections: {},
  OpenedOther: {},
  FinishedTransfer: { status: Schema.Literals(["complete", "declined"]) },
})

export type Message = typeof Message.Type

const LoadSenderLimits = Command.define("LoadSenderLimits", {
  messages: [Message.LoadedLimits],
  execute: Effect.promise(async () => await fetchServerLimits()).pipe(Effect.map((limits) => Message.LoadedLimits({ limits: Option.fromNullishOr(limits) }))),
})

const OpenOtherTransfer = Command.define("OpenOtherTransfer", {
  messages: [Message.OpenedOther],
  execute: Effect.sync(() => {
    openOtherTransfer()

    return Message.OpenedOther()
  }),
})

export const init = (origin: string): Update.Return<Model, Message> => ({
  model: {
    fileDrop: FileDrop.init({ id: "files" }),
    tabs: Tabs.init({ id: "quick-mode" }),
    mode: "send",
    receive: Receive.init(),
    origin,
    entries: Redacted.make([]),
    rejections: Redacted.make([]),
    nextKey: 0,
    limits: Option.none(),
    limitsLoaded: false,
    autoSeal: false,
    sealed: false,
    active: false,
    status: Redacted.make(""),
    phase: "",
    done: 0,
    total: 0,
    share: Share.init().model,
    hasLink: false,
    preview: Preview.init().model,
  },
})

const add = (model: Model, files: readonly File[]): Model => {
  if (model.sealed) {
    return model
  }

  let { nextKey } = model

  const incoming = files.map((file) => {
    const key = nextKey++

    return { file, name: file.name.normalize("NFC"), key, editor: Name.init(`sender-name-${key}`) }
  })

  const change = addToSelection(Redacted.value(model.entries), incoming)

  return { ...model, entries: Redacted.make(change.selected), rejections: Redacted.make([...Redacted.value(model.rejections), ...change.rejected]), nextKey }
}

const tooLarge = (model: Model): boolean => {
  const total = Redacted.value(model.entries).reduce((sum, entry) => sum + entry.file.size, 0)

  return Option.isSome(model.limits) && estimatedRelayedBytes(total) > model.limits.value.relayedBytesPerRoom
}

const seal = (model: Model): Update.Return<Model, Message> => {
  if (model.sealed || !model.limitsLoaded || Redacted.value(model.entries).length === 0 || Redacted.value(model.rejections).length > 0 || tooLarge(model)) {
    return { model: { ...model, autoSeal: false } }
  }

  return { model: { ...model, sealed: true, active: true, autoSeal: false, status: Redacted.make("Preparing files."), phase: "sealing" } }
}

export const boot = (flags: {
  readonly files?: Redacted.Redacted<readonly File[]>
  readonly autoSeal: boolean
  readonly origin: string
}): Update.Return<Model, Message> => {
  const initial = init(flags.origin).model
  const model = flags.files === undefined ? initial : add(initial, Redacted.value(flags.files))

  return { model: { ...model, autoSeal: flags.autoSeal }, commands: [LoadSenderLimits()] }
}

const foldDrop = Update.foldChild({
  update: FileDrop.update,
  read: (model: Model) => Option.some(model.fileDrop),
  write: (model: Model, fileDrop: FileDrop.Model): Model => ({ ...model, fileDrop }),
  toParentMessage: (message: FileDrop.Message) => Message.ReceivedPrivateFileDropMessage({ message: Redacted.make(message) }),
  foldOutMessage:
    (out: FileDrop.OutMessage) =>
    (model: Model): Update.Return<Model, Message> =>
      out._tag === "ReceivedFiles"
        ? { model: add(model, out.files) }
        : { model: { ...model, status: Redacted.make("Choose or drop files, not text or folders.") } },
})

const foldShare = Update.foldChild({
  update: Share.update,
  read: (model: Model) => Option.some(model.share),
  write: (model: Model, share: Share.Model): Model => ({ ...model, share }),
  toParentMessage: (message: Share.Message) => Message.GotShareMessage({ message }),
})

const foldPreview = Update.foldChild({
  update: Preview.update,
  read: (model: Model) => Option.some(model.preview),
  write: (model: Model, preview: Preview.Model): Model => ({ ...model, preview }),
  toParentMessage: (message: Preview.Message) => Message.ReceivedPrivatePreviewMessage({ message: Redacted.make(message) }),
})

const ModeTabs = Tabs.create<"send" | "receive">()

const foldTabs = Update.foldChild({
  update: ModeTabs.update,
  read: (model: Model) => Option.some(model.tabs),
  write: (model: Model, tabs: Tabs.Model): Model => ({ ...model, tabs }),
  toParentMessage: (message: Tabs.Message) => Message.GotTabsMessage({ message }),
  foldOutMessage:
    (out: Tabs.OutMessage) =>
    (model: Model): Update.Return<Model, Message> => ({ model: { ...model, mode: out.value === "receive" ? "receive" : "send" } }),
})

const foldReceive = (model: Model, message: Receive.Message) =>
  Update.foldChild({
    update: (receive: Receive.Model, incoming: Receive.Message) =>
      Receive.update(receive, incoming, { origin: model.origin, canNavigate: !model.active && (model.sealed || Redacted.value(model.entries).length === 0) }),
    read: (parent: Model) => Option.some(parent.receive),
    write: (parent: Model, receive: Receive.Model) => ({ ...parent, receive }),
    toParentMessage: (incoming: Receive.Message) => Message.GotReceiveMessage({ message: incoming }),
  })(model, message)

export const update = (model: Model, incoming: Message): Update.Return<Model, Message> =>
  Message.match(incoming, {
    GotTabsMessage: ({ message }) => foldTabs(model, message),
    GotReceiveMessage: ({ message }) => foldReceive(model, message),
    ReceivedPrivateFileDropMessage: ({ message }) => foldDrop(model, Redacted.value(message)),
    ReceivedPrivateNameMessage: ({ key, message }) => {
      const entries = Redacted.value(model.entries)
      const index = entries.findIndex((entry) => entry.key === key)
      const entry = entries[index]

      if (entry === undefined || model.sealed) {
        return { model }
      }

      const foldName = Update.foldChild({
        update: (child: Name.Model, childMessage: Name.Message) =>
          Name.update(child, childMessage, { name: Redacted.make(entry.name), names: entries.map((item) => item.name), index, canRename: true }),
        read: (parent: Model) => Option.fromNullishOr(Redacted.value(parent.entries).find((item) => item.key === key)?.editor),
        write: (parent: Model, editor: Name.Model): Model => ({
          ...parent,
          entries: Redacted.make(Redacted.value(parent.entries).map((item) => (item.key === key ? { ...item, editor } : item))),
        }),
        toParentMessage: (childMessage: Name.Message) => Message.ReceivedPrivateNameMessage({ key, message: Redacted.make(childMessage) }),
        foldOutMessage:
          (out: Name.OutMessage) =>
          (parent: Model): Update.Return<Model, Message> => ({
            model: {
              ...parent,
              entries: Redacted.make(Redacted.value(parent.entries).map((item) => (item.key === key ? { ...item, name: Redacted.value(out.name) } : item))),
            },
          }),
      })

      return foldName(model, Redacted.value(message))
    },
    GotShareMessage: ({ message }) => foldShare(model, message),
    ReceivedPrivatePreviewMessage: ({ message }) => foldPreview(model, Redacted.value(message)),
    LoadedLimits: ({ limits }) => {
      const next = { ...model, limits, limitsLoaded: true }

      return next.autoSeal ? seal(next) : { model: next }
    },
    RequestedRemove: ({ key }) => ({
      model: model.sealed
        ? model
        : {
            ...model,
            entries: Redacted.make(
              removeFromSelection(
                Redacted.value(model.entries),
                Redacted.value(model.entries).findIndex((entry) => entry.key === key),
              ),
            ),
          },
    }),
    RequestedPreview: ({ key }) => {
      const entry = Redacted.value(model.entries).find((item) => item.key === key)

      if (entry === undefined) {
        return { model }
      }

      const openPreview = Update.foldChildStep({
        update: (child: Preview.Model) =>
          Preview.open(child, Redacted.make({ file: entry.file, name: entry.name, returnFocusId: `sender-preview-${entry.key}` })),
        read: (parent: Model) => Option.some(parent.preview),
        write: (parent: Model, preview: Preview.Model): Model => ({ ...parent, preview }),
        toParentMessage: (childMessage: Preview.Message) => Message.ReceivedPrivatePreviewMessage({ message: Redacted.make(childMessage) }),
      })

      return openPreview(model)
    },
    RequestedSeal: () => seal(model),
    RequestedCancel: () => ({ model: { ...model, active: false, status: Redacted.make("Transfer cancelled.") } }),
    RequestedOther: () => ({ model, commands: [OpenOtherTransfer()] }),
    OpenedOther: () => ({ model }),
    DismissedRejections: () => ({ model: { ...model, rejections: Redacted.make([]) } }),
    ReceivedStatus: ({ text }) => (model.active ? { model: { ...model, status: text } } : { model }),
    ReceivedProgress: ({ phase, done, total }) => (model.active ? { model: { ...model, phase, done, total } } : { model }),
    ReceivedLink: ({ link }) => {
      if (!model.active) {
        return { model }
      }

      const bootShare = Update.foldChildStep({
        update: () => Share.boot(link),
        read: (parent: Model) => Option.some(parent.share),
        write: (parent: Model, share: Share.Model): Model => ({ ...parent, share }),
        toParentMessage: (childMessage: Share.Message) => Message.GotShareMessage({ message: childMessage }),
      })

      return bootShare({ ...model, hasLink: true })
    },
    FailedTransfer: ({ reason, detail }) =>
      model.active
        ? {
            model: {
              ...model,
              active: false,
              status: Redacted.make(`${describeFailure(reason)}${Redacted.value(detail) === undefined ? "" : ` ${Redacted.value(detail)}`}`),
            },
          }
        : { model },
    FinishedTransfer: ({ status }) =>
      model.active
        ? {
            model: {
              ...model,
              active: false,
              status: Redacted.make(
                status === "complete" ? "Delivered. The recipient has every file, checked against the contract." : "The recipient declined the files.",
              ),
            },
          }
        : { model },
  })

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  transfer: entry(
    { entries: Entries, active: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ entries: model.entries, active: model.active }),
      dependenciesToStream: ({ entries, active }) =>
        active
          ? Stream.callback<Message>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() =>
                  startTransfer(Redacted.value(entries), (event) => {
                    switch (event.type) {
                      case "status": {
                        Queue.offerUnsafe(queue, Message.ReceivedStatus({ text: Redacted.make(event.text) }))
                        break
                      }

                      case "progress": {
                        Queue.offerUnsafe(queue, Message.ReceivedProgress(event))
                        break
                      }

                      case "link": {
                        Queue.offerUnsafe(queue, Message.ReceivedLink({ link: Redacted.make(event.link) }))
                        break
                      }

                      case "failure": {
                        Queue.offerUnsafe(queue, Message.FailedTransfer({ reason: event.reason, detail: Redacted.make(event.detail) }))
                        break
                      }

                      case "finished": {
                        Queue.offerUnsafe(queue, Message.FinishedTransfer({ status: event.status }))
                        break
                      }
                    }
                  }),
                ),
                (stop) => Effect.promise(stop),
              ).pipe(Effect.flatMap(() => Effect.never)),
            )
          : Stream.empty,
    },
  ),
}))

export const view = defineView<Model, Message>((model, h) => {
  const entries = Redacted.value(model.entries)
  const rejections = Redacted.value(model.rejections)
  const total = entries.reduce((sum, entry) => sum + entry.file.size, 0)

  const send = () =>
    h.div(
      [],
      [
        ...(model.sealed
          ? []
          : [
              h.submodel({
                slotId: "sender-files",
                model: model.fileDrop,
                view: FileDrop.view,
                toParentMessage: (message) => Message.ReceivedPrivateFileDropMessage({ message: Redacted.make(message) }),
                viewInputs: {
                  multiple: true,
                  toView: (attributes: FileDrop.FileDropAttributes) =>
                    h.label(
                      [...attributes.root, h.Class("drop-zone")],
                      [
                        h.span([h.Class("upload-icon")], [icon(h, "upload")]),
                        h.strong([], ["Drop files here"]),
                        h.span([], ["or choose files from your device"]),
                        h.span([h.Class("button primary")], [icon(h, "plus"), entries.length === 0 ? "Choose files" : "Add more files"]),
                        h.input([...attributes.input, h.Class("visually-hidden"), h.AriaLabel("Choose files")]),
                      ],
                    ),
                },
              }),
            ]),
        ...(rejections.length > 0
          ? [
              h.div(
                [h.Role("alert")],
                [
                  h.ul(
                    [h.Class("rejections")],
                    rejections.map((rejection) => h.li([], [`${rejection.name} was not added: ${rejection.reason}.`])),
                  ),
                ],
              ),
            ]
          : []),
        ...(rejections.length > 0
          ? [
              Button.view(
                { onClick: Message.DismissedRejections(), toView: (attributes) => h.button(attributes.button, ["Continue without rejected files"]) },
                h,
              ),
            ]
          : []),
        ...(model.sealed ? [h.h2([h.Class("sealing-heading")], [model.hasLink ? "Parcel sealed" : "Sealing parcel"])] : []),
        h.ul(
          [h.Class("file-list"), h.AriaLabel("Files to send")],
          entries.map((entry, index) =>
            h.keyed("li")(
              entry.key,
              [],
              [
                model.sealed
                  ? h.span([h.Class("name")], [entry.name])
                  : h.submodel({
                      slotId: `name-${entry.key}`,
                      model: entry.editor,
                      view: Name.view,
                      toParentMessage: (message) => Message.ReceivedPrivateNameMessage({ key: entry.key, message: Redacted.make(message) }),
                      viewInputs: { name: Redacted.make(entry.name), names: entries.map((item) => item.name), index, canRename: true },
                    }),
                h.span([h.Class("size")], [formatSize(entry.file.size)]),
                Button.view(
                  {
                    onClick: Message.RequestedPreview({ key: entry.key }),
                    toView: (attributes) =>
                      h.button([...attributes.button, h.Id(`sender-preview-${entry.key}`), h.AriaLabel(`Preview ${entry.name}`)], ["Preview"]),
                  },
                  h,
                ),
                ...(model.sealed
                  ? []
                  : [
                      Button.view(
                        {
                          onClick: Message.RequestedRemove({ key: entry.key }),
                          toView: (attributes) => h.button([...attributes.button, h.Class("remove"), h.AriaLabel(`Remove ${entry.name}`)], ["Remove"]),
                        },
                        h,
                      ),
                    ]),
              ],
            ),
          ),
        ),
        h.p(
          [h.Class("selection-total")],
          [entries.length === 0 ? "" : `${entries.length} ${entries.length === 1 ? "file" : "files"}, ${formatSize(total)} in total`],
        ),
        ...(tooLarge(model) && !model.sealed && Option.isSome(model.limits)
          ? [
              h.p(
                [h.Class("limit-warning"), h.Role("alert")],
                [
                  `This server relays up to ${formatSize(model.limits.value.relayedBytesPerRoom)} per parcel, and these files need about ${formatSize(estimatedRelayedBytes(total))}. Remove some files, send them in more than one parcel, or use an instance with a higher limit.`,
                ],
              ),
            ]
          : []),
        ...(model.sealed || entries.length === 0
          ? []
          : [
              Button.view(
                {
                  onClick: Message.RequestedSeal(),
                  isDisabled: !model.limitsLoaded || entries.length === 0 || rejections.length > 0 || tooLarge(model),
                  toView: (attributes) => h.button([...attributes.button, h.Class("primary")], ["Seal parcel and create link"]),
                },
                h,
              ),
              h.p([h.Class("seal-note")], ["Sealing locks these files and their names. To change them, you start a new parcel."]),
            ]),
        ...(model.sealed
          ? [
              Progress.view(
                {
                  id: "send-progress",
                  value: model.done,
                  max: model.total || 1,
                  ariaLabel: model.phase === "sealing" ? "Sealing parcel" : "Sending files",
                  toView: (attributes) =>
                    h.div(
                      [...attributes.progress, h.Class("progress")],
                      [h.div(attributes.track, [h.div(attributes.indicator)]), h.span(attributes.label, [`${model.done} / ${model.total}`])],
                    ),
                },
                h,
              ),
            ]
          : []),
        ...(model.hasLink
          ? [h.submodel({ slotId: "sender-share", model: model.share, view: Share.view, toParentMessage: (message) => Message.GotShareMessage({ message }) })]
          : []),
        ...(model.sealed
          ? [Button.view({ onClick: Message.RequestedOther(), toView: (attributes) => h.button(attributes.button, ["Send other files"]) }, h)]
          : []),
        h.p([h.Class("status"), h.Role("status")], [Redacted.value(model.status)]),
        ...(model.active ? [Button.view({ onClick: Message.RequestedCancel(), toView: (attributes) => h.button(attributes.button, ["Cancel"]) }, h)] : []),
        h.submodel({
          slotId: "sender-preview",
          model: model.preview,
          view: Preview.view,
          toParentMessage: (message) => Message.ReceivedPrivatePreviewMessage({ message: Redacted.make(message) }),
        }),
      ],
    )

  return h.section(
    [h.Id("quick"), h.Class("panel quick"), h.AriaLabelledBy("send-heading")],
    [
      h.submodel({
        slotId: "quick-mode",
        model: model.tabs,
        view: ModeTabs.view,
        toParentMessage: (message) => Message.GotTabsMessage({ message }),
        viewInputs: {
          tabs: ["send", "receive"],
          selectedValue: model.mode,
          ariaLabel: "Quick Share mode",
          toView: (render) =>
            h.div(
              [],
              [
                h.div(
                  [h.Class("quick-header")],
                  [
                    h.div(
                      [h.Class("heading")],
                      [
                        h.span([h.Class("section-icon")], [icon(h, "send")]),
                        h.div([], [h.h2([h.Id("send-heading")], ["Quick Share"]), h.p([], ["Send files securely, directly from your browser."])]),
                      ],
                    ),
                    h.div(
                      [...render.tablist, h.Class("mode-tabs")],
                      render.tabs.map((tab) => h.button([...tab.tab], [tab.value === "send" ? "Send" : "Receive"])),
                    ),
                  ],
                ),
                ...render.tabs
                  .filter((tab) => tab.isActive)
                  .map((tab) =>
                    h.div(
                      [...tab.panel],
                      [
                        tab.value === "send"
                          ? send()
                          : h.submodel({
                              slotId: "receive",
                              model: model.receive,
                              view: Receive.view,
                              viewInputs: { origin: model.origin, canNavigate: !model.active && (model.sealed || entries.length === 0) },
                              toParentMessage: (message) => Message.GotReceiveMessage({ message }),
                            }),
                      ],
                    ),
                  ),
              ],
            ),
        },
      }),
      h.div([h.Class("quick-foot")], [h.span([], [icon(h, "lock"), "End-to-end encrypted"]), h.a([h.Href(securityRouter())], ["Security"])]),
    ],
  )
})
