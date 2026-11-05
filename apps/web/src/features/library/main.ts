import { DateTime, Effect, Option, Redacted, Schema } from "effect"
import { Command, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { HtmlBuilder } from "foldkit/html"
import { defineView } from "foldkit/submodel"
import { Button, Checkbox, Dialog, Disclosure, FileDrop, Input, Tabs } from "@foldkit/ui"
import { icon } from "../../ui/icon.ts"
import { privateValue } from "../../ui/privateValue.ts"
import { deriveMyFiles } from "@file-transfer/catalog"
import type { LibraryCollection, LibrarySnapshot } from "@file-transfer/catalog"
import * as BrowserCatalog from "../../capabilities/catalog/browser.ts"
import * as Preview from "../../capabilities/preview/main.ts"

type Snapshot = LibrarySnapshot

type Entry = Snapshot["files"][number]

type Review = readonly BrowserCatalog.ReviewedFile[]

type Action =
  | { readonly kind: "load" }
  | { readonly kind: "configure"; readonly enabled: boolean; readonly epoch: number }
  | { readonly kind: "index"; readonly files: readonly File[]; readonly epoch: number; readonly reconnect: Entry | undefined }
  | { readonly kind: "picker"; readonly epoch: number }
  | { readonly kind: "create"; readonly name: string; readonly epoch: number }
  | { readonly kind: "add"; readonly collection: LibraryCollection; readonly files: readonly Entry[]; readonly epoch: number }
  | { readonly kind: "remove"; readonly collection: LibraryCollection; readonly file: Entry; readonly epoch: number }
  | { readonly kind: "forgetFile"; readonly file: Entry; readonly epoch: number }
  | { readonly kind: "forgetCollection"; readonly collection: LibraryCollection; readonly epoch: number }
  | { readonly kind: "reconnect"; readonly previous: Entry; readonly current: BrowserCatalog.IndexedVersion; readonly epoch: number }
  | { readonly kind: "review"; readonly entries: Snapshot["files"]; readonly collection: LibraryCollection | undefined; readonly epoch: number }
  | { readonly kind: "preview"; readonly entry: Entry }
  | { readonly kind: "approve"; readonly reviewed: Review; readonly collection: LibraryCollection | undefined; readonly epoch: number }

type Result =
  | { readonly kind: "loaded"; readonly snapshot: Snapshot }
  | { readonly kind: "snapshot"; readonly snapshot: Snapshot }
  | { readonly kind: "review"; readonly reviewed: Review; readonly collection: LibraryCollection | undefined; readonly epoch: number }
  | { readonly kind: "candidate"; readonly previous: Entry; readonly current: BrowserCatalog.IndexedVersion; readonly epoch: number }
  | { readonly kind: "preview"; readonly file: File; readonly identifier: number }
  | { readonly kind: "share"; readonly snapshot: Snapshot; readonly files: readonly File[] }

type Confirmation =
  | { readonly kind: "none" }
  | { readonly kind: "add" }
  | { readonly kind: "create" }
  | { readonly kind: "manage"; readonly entry: Entry }
  | { readonly kind: "disable"; readonly epoch: number }
  | { readonly kind: "forgetFile"; readonly entry: Entry; readonly epoch: number }
  | { readonly kind: "forgetCollection"; readonly collection: LibraryCollection; readonly epoch: number }
  | { readonly kind: "candidate"; readonly previous: Entry; readonly current: BrowserCatalog.IndexedVersion; readonly epoch: number }
  | { readonly kind: "review"; readonly reviewed: Review; readonly collection: LibraryCollection | undefined; readonly epoch: number }

export const Model = Schema.Struct({
  snapshot: privateValue<Snapshot>(),
  loadState: Schema.Literals(["loading", "ready", "failed"]),
  collection: Schema.Int,
  selected: Schema.Array(Schema.Int),
  name: privateValue<string>(),
  search: privateValue<string>(),
  confirmation: privateValue<Confirmation>(),
  reconnect: Schema.Option(Schema.Int),
  detailsOpen: Schema.Boolean,
  storageLocation: Schema.Literals(["device", "cloud"]),
  tabs: Tabs.Model,
  dialog: Dialog.Model,
  fileDrop: FileDrop.Model,
  preview: Preview.Model,
  operation: Schema.Literals(["idle", "catalog", "source", "preview", "cancelling"]),
  dropGeneration: Schema.Int,
  generation: Schema.Int,
  status: Schema.String,
})

export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  GotTabsMessage: { message: Tabs.Message },
  GotDialogMessage: { message: Dialog.Message },
  GotFileDropMessage: { message: privateValue<FileDrop.Message>(), generationId: Schema.Int },
  GotPreviewMessage: { message: privateValue<Preview.Message>() },
  RequestedPreview: { identifier: Schema.Int },
  CancelledPreview: {},
  ChangedCollectionName: { name: privateValue<string>() },
  ChangedSearch: { search: privateValue<string>() },
  ToggledDetails: { open: Schema.Boolean },
  RequestedAddDialog: {},
  RequestedCreateDialog: {},
  RequestedManageFile: { identifier: Schema.Int },
  SelectedCollection: { identifier: Schema.Int },
  ToggledFile: { identifier: Schema.Int },
  RequestedEnable: {},
  RequestedDisable: {},
  RequestedReload: {},
  RequestedCreateCollection: {},
  RequestedDurablePicker: {},
  RequestedAddMembers: { identifier: Schema.Int },
  RequestedRemoveMember: { identifier: Schema.Int },
  RequestedForgetFile: { identifier: Schema.Int },
  RequestedForgetCollection: {},
  RequestedReconnect: { identifier: Schema.Int },
  CancelledReconnect: {},
  RequestedReview: {},
  RequestedReviewFile: { identifier: Schema.Int },
  RequestedReviewCollection: {},
  ConfirmedAction: {},
  SucceededLibraryAction: { generation: Schema.Int, result: privateValue<Result>() },
  FailedLibraryAction: { generation: Schema.Int },
  CompletedCancelRunLibraryAction: {},
})

export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ RequestedQuickShare: { files: privateValue<readonly File[]>() } })

export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const LocationTabs = Tabs.create<"device" | "cloud">()

const perform = Effect.fnUntraced(function* (action: Action): Effect.fn.Return<Result, BrowserCatalog.LibraryStorageError> {
  switch (action.kind) {
    case "load": {
      return { kind: "loaded", snapshot: yield* BrowserCatalog.readLibrary }
    }

    case "configure": {
      return { kind: "snapshot", snapshot: yield* BrowserCatalog.configureCatalog(action.enabled, action.epoch) }
    }

    case "index": {
      const indexed = yield* BrowserCatalog.indexCatalogFiles(action.files)

      if (action.reconnect !== undefined) {
        const current = indexed[0]

        if (current === undefined || indexed.length !== 1) {
          return yield* new BrowserCatalog.LibraryStorageError({ cause: "Choose exactly one original to reconnect" })
        }

        return { kind: "candidate", previous: action.reconnect, current, epoch: action.epoch }
      }

      return { kind: "snapshot", snapshot: yield* BrowserCatalog.rememberFiles(indexed, action.epoch) }
    }

    case "picker": {
      return { kind: "snapshot", snapshot: yield* BrowserCatalog.rememberFiles(yield* BrowserCatalog.chooseCatalogFiles(true), action.epoch) }
    }

    case "create": {
      return { kind: "snapshot", snapshot: yield* BrowserCatalog.createCollection(action.name, action.epoch) }
    }

    case "add": {
      return { kind: "snapshot", snapshot: yield* BrowserCatalog.addToCollection(action.collection, action.files, action.epoch) }
    }

    case "remove": {
      return { kind: "snapshot", snapshot: yield* BrowserCatalog.removeFromCollection(action.collection, action.file, action.epoch) }
    }

    case "forgetFile": {
      return { kind: "snapshot", snapshot: yield* BrowserCatalog.deleteFile(action.file, action.epoch) }
    }

    case "forgetCollection": {
      return { kind: "snapshot", snapshot: yield* BrowserCatalog.deleteCollection(action.collection, action.epoch) }
    }

    case "reconnect": {
      return { kind: "snapshot", snapshot: yield* BrowserCatalog.reconnectFile(action.previous, action.current, action.epoch) }
    }

    case "preview": {
      const reviewed = yield* BrowserCatalog.reviewCatalogFiles([action.entry])
      const entry = reviewed[0]

      if (entry === undefined) {
        return yield* new BrowserCatalog.LibraryStorageError({ cause: "Original unavailable" })
      }

      return { kind: "preview", file: entry.file, identifier: action.entry.identifier }
    }

    case "review": {
      return { kind: "review", reviewed: yield* BrowserCatalog.reviewCatalogFiles(action.entries), collection: action.collection, epoch: action.epoch }
    }

    case "approve": {
      const snapshot = yield* BrowserCatalog.approveVersions(action.reviewed, action.epoch, action.collection)

      return { kind: "share", snapshot, files: action.reviewed.map((entry) => entry.file) }
    }
  }
})

/** One operation admitted at a time by busy. The key is an address, not a lock.
 * The Runtime owns execution. Generation drops already-queued stale results.
 * Browser pickers cannot be dismissed programmatically; interrupted late results cannot commit.
 */
export const RunLibraryAction = Command.define("RunLibraryAction", {
  args: { action: privateValue<Action>(), generation: Schema.Int },
  messages: [Message.SucceededLibraryAction, Message.FailedLibraryAction],
  interrupt: true,
  execute: ({ action, generation }) =>
    perform(Redacted.value(action)).pipe(
      Effect.map((result) => Message.SucceededLibraryAction({ generation, result: Redacted.make(result) })),
      Effect.catchTag("LibraryStorageError", () => Effect.succeed(Message.FailedLibraryAction({ generation }))),
    ),
})

export const cancel = (model: Model): Update.Return<Model, Message> =>
  model.operation === "cancelling"
    ? { model }
    : {
        model: { ...model, operation: "cancelling", dropGeneration: model.dropGeneration + 1, generation: model.generation + 1 },
        commands: [RunLibraryAction.Interrupt(() => Message.CompletedCancelRunLibraryAction())],
      }

const operationFor = (action: Action): Model["operation"] => {
  if (action.kind === "preview") {
    return "preview"
  }

  if (action.kind === "picker" || action.kind === "index") {
    return "source"
  }

  return "catalog"
}

const start = (model: Model, action: Action): Update.Return<Model, Message> =>
  model.operation === "idle"
    ? {
        model: {
          ...model,
          operation: operationFor(action),
          generation: model.generation + 1,
          status: "Working locally. No file content is being uploaded.",
        },
        commands: [RunLibraryAction({ action: Redacted.make(action), generation: model.generation + 1 })],
      }
    : { model }

export const init = (): Update.Return<Model, Message> => ({
  model: {
    snapshot: Redacted.make({ enabled: false, epoch: 0, files: [], collections: [] }),
    loadState: "loading",
    collection: 0,
    selected: [],
    name: Redacted.make(""),
    search: Redacted.make(""),
    confirmation: Redacted.make({ kind: "none" }),
    reconnect: Option.none(),
    detailsOpen: false,
    storageLocation: "device",
    tabs: Tabs.init({ id: "library-location" }),
    preview: Preview.init().model,
    dialog: Dialog.init({ id: "library-confirmation" }),
    fileDrop: FileDrop.init({ id: "library-files" }),
    operation: "idle",
    dropGeneration: 0,
    generation: 0,
    status: "Loading local Library.",
  },
})

export const boot = (): Update.Return<Model, Message> => start(init().model, { kind: "load" })

const liftDialog = (message: Dialog.Message): Message => Message.GotDialogMessage({ message })

const foldDialogOut =
  (out: Dialog.OutMessage) =>
  (model: Model): Update.Return<Model, Message> => {
    if (out._tag !== "Closed") {
      return { model }
    }

    const closed = { ...model, reconnect: Option.none(), confirmation: Redacted.make<Confirmation>({ kind: "none" }) }

    if (model.operation === "source" && Redacted.value(model.confirmation).kind === "add") {
      return cancel(closed)
    }

    return { model: closed }
  }

const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.dialog),
  write: (model: Model, dialog: Dialog.Model): Model => ({ ...model, dialog }),
  toParentMessage: liftDialog,
  foldOutMessage: foldDialogOut,
})

const openDialog = Update.foldChildStep({
  update: Dialog.open,
  read: (model: Model) => Option.some(model.dialog),
  write: (model: Model, dialog: Dialog.Model): Model => ({ ...model, dialog }),
  toParentMessage: liftDialog,
  foldOutMessage: foldDialogOut,
})

const closeDialog = Update.foldChildStep({
  update: Dialog.close,
  read: (model: Model) => Option.some(model.dialog),
  write: (model: Model, dialog: Dialog.Model): Model => ({ ...model, dialog }),
  toParentMessage: liftDialog,
  foldOutMessage: foldDialogOut,
})

const ask = (model: Model, confirmation: Confirmation): Return => openDialog({ ...model, confirmation: Redacted.make(confirmation) })

const foldTabs = Update.foldChild({
  update: LocationTabs.update,
  read: (model: Model) => Option.some(model.tabs),
  write: (model: Model, tabs: Tabs.Model): Model => ({ ...model, tabs }),
  toParentMessage: (message: Tabs.Message) => Message.GotTabsMessage({ message }),
  foldOutMessage:
    (out: Tabs.OutMessage) =>
    (model: Model): Return => ({ model: { ...model, storageLocation: out.value === "cloud" ? "cloud" : "device" } }),
})

const foldDrop = (generation: number) =>
  Update.foldChild({
    update: FileDrop.update,
    read: (model: Model) => Option.some(model.fileDrop),
    write: (model: Model, fileDrop: FileDrop.Model): Model => ({ ...model, fileDrop }),
    toParentMessage: (message: FileDrop.Message) => Message.GotFileDropMessage({ message: Redacted.make(message), generationId: generation }),
    foldOutMessage:
      (out: FileDrop.OutMessage) =>
      (model: Model): Return => {
        const snapshot = Redacted.value(model.snapshot)

        if (out._tag === "RejectedNonFiles") {
          return { model: { ...model, status: "Choose or drop files, not text or folders." } }
        }

        if (!snapshot.enabled || model.operation !== "idle") {
          return { model }
        }

        const reconnect = snapshot.files.find((entry) => Option.contains(model.reconnect, entry.identifier))

        return start(model, { kind: "index", files: out.files, epoch: snapshot.epoch, reconnect })
      },
  })

const liftPreview = (message: Preview.Message): Message => Message.GotPreviewMessage({ message: Redacted.make(message) })

const foldPreview = Update.foldChild({
  update: Preview.update,
  read: (model: Model) => Option.some(model.preview),
  write: (model: Model, preview: Preview.Model): Model => ({ ...model, preview }),
  toParentMessage: liftPreview,
})

const openPreview = (model: Model, file: File, identifier: number): Return =>
  Update.foldChildStep({
    update: (preview: Preview.Model) => Preview.open(preview, Redacted.make({ file, name: file.name, returnFocusId: `library-preview-${identifier}` })),
    read: (parent: Model) => Option.some(parent.preview),
    write: (parent: Model, preview: Preview.Model): Model => ({ ...parent, preview }),
    toParentMessage: liftPreview,
  })(model)

export const update = (model: Model, incoming: Message): Return => {
  const snapshot = Redacted.value(model.snapshot)
  const collection = snapshot.collections.find((entry) => entry.identifier === model.collection)
  const { epoch } = snapshot

  return Message.match<Return>(incoming, {
    GotPreviewMessage: ({ message }) => foldPreview(model, Redacted.value(message)),
    RequestedPreview: ({ identifier }) => {
      const entry = snapshot.files.find((file) => file.identifier === identifier)

      return entry === undefined || !snapshot.enabled ? { model } : start(model, { kind: "preview", entry })
    },
    CancelledPreview: () => (model.operation === "preview" ? cancel(model) : { model }),
    GotTabsMessage: (message) => (model.operation === "idle" ? foldTabs(model, message.message) : { model }),
    GotDialogMessage: (message) => foldDialog(model, message.message),
    GotFileDropMessage: (message) =>
      message.generationId === model.dropGeneration && Redacted.value(model.confirmation).kind === "add"
        ? foldDrop(message.generationId)(model, Redacted.value(message.message))
        : { model },
    ChangedCollectionName: (message) => ({ model: { ...model, name: message.name } }),
    ChangedSearch: (message) => ({ model: { ...model, search: message.search } }),
    ToggledDetails: (message) => ({ model: { ...model, detailsOpen: message.open } }),
    RequestedAddDialog: () =>
      model.operation === "idle" ? ask({ ...model, dropGeneration: model.dropGeneration + 1, reconnect: Option.none() }, { kind: "add" }) : { model },
    RequestedCreateDialog: () => (model.operation === "idle" ? ask(model, { kind: "create" }) : { model }),
    RequestedManageFile: (message) => {
      const entry = snapshot.files.find((file) => file.identifier === message.identifier)

      return entry === undefined || model.operation !== "idle" ? { model } : ask(model, { kind: "manage", entry })
    },
    SelectedCollection: (message) => ({ model: { ...model, collection: message.identifier, selected: [] } }),
    ToggledFile: (message) => ({
      model: {
        ...model,
        selected: model.selected.includes(message.identifier)
          ? model.selected.filter((id) => id !== message.identifier)
          : [...model.selected, message.identifier],
      },
    }),
    RequestedReload: () => start(model.loadState === "failed" ? { ...model, loadState: "loading" } : model, { kind: "load" }),
    RequestedEnable: () => start(model, { kind: "configure", enabled: true, epoch }),
    RequestedDisable: () => (model.operation === "idle" ? ask(model, { kind: "disable", epoch }) : { model }),
    RequestedCreateCollection: () =>
      snapshot.enabled && Redacted.value(model.name).trim().length > 0
        ? start(model, { kind: "create", name: Redacted.value(model.name).trim(), epoch })
        : { model },
    RequestedDurablePicker: () => (snapshot.enabled ? start(model, { kind: "picker", epoch }) : { model }),
    RequestedAddMembers: (message) => {
      if (!snapshot.enabled || model.selected.length === 0 || message.identifier === 0 || model.operation !== "idle") {
        return { model }
      }

      const target = snapshot.collections.find((entry) => entry.identifier === message.identifier)
      const files = snapshot.files.filter((entry) => model.selected.includes(entry.identifier))

      return target === undefined || files.length !== model.selected.length
        ? { model: { ...model, status: "The selected files or collection are no longer available. Reload the Library and select them again." } }
        : start(model, { kind: "add", collection: target, files, epoch })
    },
    RequestedRemoveMember: (message) => {
      if (model.operation !== "idle") {
        return { model }
      }

      const file = snapshot.files.find((entry) => entry.identifier === message.identifier)

      return collection === undefined || file === undefined
        ? { model: { ...model, status: "The selected file or collection is no longer available. Reload the Library and select it again." } }
        : start(model, { kind: "remove", collection, file, epoch })
    },
    RequestedForgetFile: (message) => {
      const entry = snapshot.files.find((file) => file.identifier === message.identifier)

      return entry === undefined || model.operation !== "idle" ? { model } : ask(model, { kind: "forgetFile", entry, epoch })
    },
    RequestedForgetCollection: () =>
      collection === undefined || model.operation !== "idle" ? { model } : ask(model, { kind: "forgetCollection", collection, epoch }),
    RequestedReconnect: (message) =>
      ask(
        {
          ...model,
          dropGeneration: model.dropGeneration + 1,
          reconnect: Option.some(message.identifier),
          status: "Choose exactly one original in the file chooser below. Review and confirm before replacing its reference.",
        },
        { kind: "add" },
      ),
    CancelledReconnect: () => ({ model: { ...model, reconnect: Option.none(), status: "Reconnection cancelled. The saved reference is unchanged." } }),
    RequestedReview: () => {
      const entries = snapshot.files.filter((entry) => model.selected.includes(entry.identifier))

      if (entries.length !== model.selected.length) {
        return { model: { ...model, status: "The selected files are no longer available. Reload the Library and select them again." } }
      }

      return entries.length === 0 ? { model } : start(model, { kind: "review", entries, collection: undefined, epoch })
    },
    RequestedReviewFile: (message) => {
      const entry = snapshot.files.find((file) => file.identifier === message.identifier)

      return entry === undefined ? { model } : start(model, { kind: "review", entries: [entry], collection: undefined, epoch })
    },
    RequestedReviewCollection: () => {
      const current = collection ?? deriveMyFiles(snapshot)
      const entries = snapshot.files.filter((entry) => current.fileIdentifiers.includes(entry.identifier))

      if (entries.length !== current.fileIdentifiers.length) {
        return { model: { ...model, status: "The collection contains unavailable files. Reload the Library and review it again." } }
      }

      return entries.length === 0 ? { model } : start(model, { kind: "review", entries, collection: current, epoch })
    },
    ConfirmedAction: () => {
      if (model.operation !== "idle") {
        return { model }
      }

      const confirmation = Redacted.value(model.confirmation)
      let action: Action

      switch (confirmation.kind) {
        case "none": {
          return { model }
        }

        case "add":
        case "manage":
        case "create": {
          return { model }
        }

        case "disable": {
          action = { kind: "configure", enabled: false, epoch: confirmation.epoch }
          break
        }

        case "forgetFile": {
          action = { kind: "forgetFile", file: confirmation.entry, epoch: confirmation.epoch }
          break
        }

        case "forgetCollection": {
          action = { kind: "forgetCollection", collection: confirmation.collection, epoch: confirmation.epoch }
          break
        }

        case "candidate": {
          action = { kind: "reconnect", previous: confirmation.previous, current: confirmation.current, epoch: confirmation.epoch }
          break
        }

        case "review": {
          action = { kind: "approve", reviewed: confirmation.reviewed, collection: confirmation.collection, epoch: confirmation.epoch }
          break
        }
      }

      const closed = closeDialog(model)
      const started = start(closed.model, action)

      return { ...started, commands: [...(closed.commands ?? []), ...(started.commands ?? [])] }
    },
    SucceededLibraryAction: (message) => {
      if (!(model.operation !== "idle") || message.generation !== model.generation) {
        return { model }
      }

      const result = Redacted.value(message.result)

      if (result.kind === "preview") {
        return openPreview({ ...model, operation: "idle", status: "" }, result.file, result.identifier)
      }

      const ready: Model = {
        ...model,
        loadState: result.kind === "loaded" ? "ready" : model.loadState,
        operation: "idle",
        status: result.kind === "loaded" ? "" : "Library updated on this device only.",
      }

      if (result.kind === "review") {
        return ask(ready, result)
      }

      if (result.kind === "candidate") {
        return ask(ready, result)
      }

      const next: Model = {
        ...ready,
        snapshot: Redacted.make(result.snapshot),
        selected: [],
        reconnect: Option.none(),
        name: Redacted.make(""),
        collection: result.snapshot.collections.some((entry) => entry.identifier === model.collection) ? model.collection : 0,
      }

      if (result.kind === "share") {
        return { model: next, outMessage: OutMessage.RequestedQuickShare({ files: Redacted.make(result.files) }) }
      }

      return ["add", "create", "manage"].includes(Redacted.value(model.confirmation).kind) ? closeDialog(next) : { model: next }
    },
    FailedLibraryAction: (message) =>
      message.generation === model.generation
        ? {
            model: {
              ...model,
              loadState: model.loadState === "loading" ? "failed" : model.loadState,
              operation: "idle",
              status:
                "Could not complete this local operation. Permission may be denied, the browser may not support durable references, or the catalog changed in another tab. Reload the Library and review again, or reselect the original. Nothing was shared.",
            },
          }
        : { model },
    CompletedCancelRunLibraryAction: () =>
      model.operation === "cancelling"
        ? {
            model: {
              ...model,
              loadState: model.loadState === "loading" ? "failed" : model.loadState,
              operation: "idle",
              status: "Local operation cancelled. Reload the Library to check for any change that committed before cancellation.",
            },
          }
        : { model },
  })
}

const button = (h: HtmlBuilder<Message>, label: string, message: Message, disabled = false) =>
  Button.view({ onClick: message, isDisabled: disabled, toView: (attributes) => h.button([...attributes.button, h.Class("button")], [label]) }, h)

export const view = defineView<Model, Message, { readonly sharingDisabled: boolean }>((model, inputs, h) => {
  if (model.loadState !== "ready") {
    return h.div(
      [h.Id("library"), h.Tabindex(-1), h.Class("library library-page"), h.AriaBusy(model.loadState === "loading")],
      [
        h.div(
          [h.Class("library-header")],
          [h.div([h.Class("heading")], [h.span([h.Class("section-icon lilac")], [icon(h, "folder")]), h.h2([], ["Local Library"])])],
        ),
        h.div(
          [h.Class("panel flex min-h-48 flex-col items-center justify-center gap-3 px-4 py-10 text-center")],
          model.loadState === "loading"
            ? [h.p([h.Role("status")], ["Loading local Library…"])]
            : [h.p([h.Role("status")], [model.status]), button(h, "Reload Library", Message.RequestedReload(), model.operation !== "idle")],
        ),
      ],
    )
  }

  const snapshot = Redacted.value(model.snapshot)

  const collection =
    model.collection === 0 ? deriveMyFiles(snapshot) : (snapshot.collections.find((entry) => entry.identifier === model.collection) ?? deriveMyFiles(snapshot))

  const disabled = model.operation !== "idle" || !snapshot.enabled
  const files = snapshot.files.filter((entry) => collection.fileIdentifiers.includes(entry.identifier))
  const search = Redacted.value(model.search).trim().toLocaleLowerCase()

  const visibleFiles = files.filter(
    (entry) =>
      entry.name.toLocaleLowerCase().includes(search) ||
      snapshot.collections.some((group) => group.fileIdentifiers.includes(entry.identifier) && group.name.toLocaleLowerCase().includes(search)),
  )

  const sharingDisabled = disabled || inputs.sharingDisabled

  const consent = () =>
    Checkbox.view(
      {
        id: "library-consent",
        isChecked: snapshot.enabled,
        isDisabled: model.operation !== "idle",
        onToggle: (enabled) => (enabled ? Message.RequestedEnable() : Message.RequestedDisable()),
        toView: (attributes) =>
          h.div(
            [h.Class("flex items-center gap-2 text-sm")],
            [
              h.button([...attributes.checkbox, h.Class("library-checkbox")], [snapshot.enabled ? icon(h, "check") : null]),
              h.span([...attributes.label], ["Remember files on this device"]),
            ],
          ),
      },
      h,
    )

  const device = () =>
    h.section(
      [h.Class("space-y-3")],
      [
        h.div(
          [h.Class("flex flex-wrap items-center justify-between gap-x-4 gap-y-1")],
          [
            h.p([h.Class("text-sm text-muted-foreground")], ["Originals stay on this device. Local edits affect future shares."]),
            Disclosure.view(
              {
                id: "library-indexing-details",
                isOpen: model.detailsOpen,
                onToggle: (open) => Message.ToggledDetails({ open }),
                toView: (details) =>
                  h.div(
                    [],
                    [
                      h.button(
                        [
                          ...details.button,
                          h.Class("min-h-8 border-0 bg-transparent p-0 font-normal text-sm text-muted-foreground underline underline-offset-4"),
                          h.AriaLabel("How local indexing works"),
                        ],
                        ["How it works"],
                      ),
                      model.detailsOpen
                        ? h.div(
                            [...details.panel],
                            [
                              h.p(
                                [],
                                [
                                  "Your Library indexes original file references and metadata on this device. Adding files does not upload or copy their contents.",
                                ],
                              ),
                              h.p(
                                [],
                                [
                                  "Standard file choosing captures a File for this page only. Reselect after editing or reopening this page. Durable references require browser support and permission.",
                                ],
                              ),
                              button(h, "Reload Library", Message.RequestedReload(), model.operation !== "idle"),
                            ],
                          )
                        : null,
                    ],
                  ),
              },
              h,
            ),
          ],
        ),
        inputs.sharingDisabled ? h.p([], ["Finish or clear Quick Share before sharing from your Library."]) : null,
        h.div(
          [h.Class("panel library-panel")],
          [
            h.div(
              [h.Class("library-tools")],
              [
                h.div(
                  [h.Class("filters")],
                  [
                    ...[deriveMyFiles(snapshot), ...snapshot.collections].map((entry) =>
                      Button.view(
                        {
                          onClick: Message.SelectedCollection({ identifier: entry.identifier }),
                          isDisabled: model.operation !== "idle",
                          toView: (attributes) =>
                            h.button(
                              [...attributes.button, h.AriaPressed(String(entry.identifier === collection.identifier))],
                              [`${entry.name} (${entry.fileIdentifiers.length})`],
                            ),
                        },
                        h,
                      ),
                    ),
                    button(h, "New collection", Message.RequestedCreateDialog(), disabled),
                  ],
                ),
                Input.view(
                  {
                    id: "library-search",
                    value: Redacted.value(model.search),
                    onInput: (query) => Message.ChangedSearch({ search: Redacted.make(query) }),
                    toView: (attributes) =>
                      h.div(
                        [h.Class("search")],
                        [
                          h.label([...attributes.label, h.Class("visually-hidden")], ["Find a file"]),
                          icon(h, "search"),
                          h.input([...attributes.input, h.Placeholder("Find a file…"), h.Type("search")]),
                        ],
                      ),
                  },
                  h,
                ),
              ],
            ),
            collection.identifier === 0 ? null : button(h, "Forget collection", Message.RequestedForgetCollection(), disabled),
            files.length === 0
              ? h.div(
                  [h.Class("flex min-h-48 flex-col items-center justify-center gap-3 px-4 py-10 text-center text-muted-foreground")],
                  [
                    h.p([], [collection.identifier === 0 ? "No files added yet." : "This collection is empty."]),
                    collection.identifier === 0
                      ? h.p(
                          [h.Class("text-sm")],
                          [snapshot.enabled ? "Use Add files to index originals on this device." : "Turn on remembering to add files to your Library."],
                        )
                      : h.p([h.Class("text-sm")], ["Select files in My files to add them to this collection."]),
                  ],
                )
              : null,
            files.length > 0 && visibleFiles.length === 0 ? h.p([], ["No matching files."]) : null,
            visibleFiles.length === 0
              ? null
              : h.ul(
                  [h.Class("catalog-list")],
                  visibleFiles.map((entry) =>
                    h.keyed("li")(
                      String(entry.identifier),
                      [h.Class("row")],
                      [
                        Checkbox.view(
                          {
                            id: `library-file-${entry.identifier}`,
                            isChecked: model.selected.includes(entry.identifier),
                            isDisabled: disabled,
                            onToggle: () => Message.ToggledFile({ identifier: entry.identifier }),
                            toView: (attributes) =>
                              h.div(
                                [],
                                [
                                  h.button(
                                    [...attributes.checkbox, h.Class("library-checkbox")],
                                    [model.selected.includes(entry.identifier) ? icon(h, "check") : null],
                                  ),
                                  h.span([...attributes.label, h.Class("visually-hidden")], [entry.name]),
                                ],
                              ),
                          },
                          h,
                        ),
                        h.span([h.Class("file-icon")], [icon(h, "file")]),
                        h.div(
                          [h.Class("file-meta")],
                          [
                            h.span([h.Class("file-name")], [entry.name]),
                            h.p(
                              [h.Class("file-detail")],
                              [
                                `${String(entry.size)} bytes. ${{ durable: "Original reference: access checked before sharing.", transient: "Reselect after edits or reopening this page.", missing: "Original unavailable. Reconnect it before sharing." }[BrowserCatalog.sourceAvailability(entry)]}`,
                              ],
                            ),
                          ],
                        ),
                        h.div(
                          [h.Class("row-actions")],
                          [
                            Button.view(
                              {
                                onClick: Message.RequestedPreview({ identifier: entry.identifier }),
                                isDisabled: disabled,
                                toView: (attributes) =>
                                  h.button(
                                    [
                                      ...attributes.button,
                                      h.Id(`library-preview-${entry.identifier}`),
                                      h.Class("button"),
                                      h.AriaLabel(`Preview ${entry.name}`),
                                    ],
                                    ["Preview"],
                                  ),
                              },
                              h,
                            ),
                            Button.view(
                              {
                                onClick: Message.RequestedManageFile({ identifier: entry.identifier }),
                                isDisabled: disabled,
                                toView: (attributes) =>
                                  h.button(
                                    [
                                      ...attributes.button,
                                      h.Class("button p-2"),
                                      h.AriaLabel(`Manage ${entry.name}`),
                                      h.Attribute("title", `Manage ${entry.name}`),
                                    ],
                                    [icon(h, "file")],
                                  ),
                              },
                              h,
                            ),
                            Button.view(
                              {
                                onClick: Message.RequestedReviewFile({ identifier: entry.identifier }),
                                isDisabled: sharingDisabled,
                                toView: (attributes) =>
                                  h.button([...attributes.button, h.Class("button"), h.AriaLabel(`Share ${entry.name}`)], [icon(h, "send"), "Share"]),
                              },
                              h,
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
            model.selected.length === 0
              ? null
              : h.div(
                  [h.Class("flex flex-wrap items-center gap-2 py-3")],
                  [
                    h.span([h.Class("text-sm text-muted-foreground")], [`${String(model.selected.length)} selected`]),
                    button(h, "Review selected files before sharing", Message.RequestedReview(), sharingDisabled),
                    ...snapshot.collections.map((entry) =>
                      button(h, `Add selected to ${entry.name}`, Message.RequestedAddMembers({ identifier: entry.identifier }), disabled),
                    ),
                  ],
                ),
            files.length === 0 ? null : button(h, "Review collection before sharing", Message.RequestedReviewCollection(), sharingDisabled),
          ],
        ),
      ],
    )

  const confirmation = Redacted.value(model.confirmation)

  let title = "Confirm forgetting"
  let description = "Only Library metadata and references will be forgotten. Your original files are never deleted."

  switch (confirmation.kind) {
    case "manage": {
      title = `Manage ${confirmation.entry.name}`
      description = "Manage this local catalog entry. Your original file is never deleted."
      break
    }

    case "add": {
      title = "Add to catalog"
      description = "Choose files to index locally. Their contents are not uploaded."
      break
    }

    case "create": {
      title = "New collection"
      description = "Create an empty collection on this device."
      break
    }

    case "candidate": {
      title = "Confirm reconnection"
      description = "Confirm that this is the intended original. Reconnecting changes its future shares, not an existing share."
      break
    }

    case "review": {
      title = "Review current versions"
      break
    }

    case "disable":
    case "forgetCollection":
    case "forgetFile":
    case "none": {
      break
    }
  }

  const actionLabel = confirmation.kind === "candidate" ? "Confirm replacement reference" : "Forget"

  const confirmationDetail = () => {
    switch (confirmation.kind) {
      case "candidate": {
        return h.p([], [`${confirmation.previous.name} → ${confirmation.current.name}, ${confirmation.current.size} bytes`])
      }

      case "forgetFile": {
        return h.p([], [confirmation.entry.name])
      }

      case "forgetCollection": {
        return h.p([], [`${confirmation.collection.name}. Its files remain in My files.`])
      }

      case "manage":
      case "add":
      case "create":
      case "disable":
      case "none":
      case "review": {
        return null
      }
    }
  }

  return h.div(
    [h.Id("library"), h.Tabindex(-1), h.Class("library library-page"), h.AriaBusy(model.operation !== "idle")],
    [
      h.div(
        [h.Class("library-header")],
        [
          h.div([h.Class("heading")], [h.span([h.Class("section-icon lilac")], [icon(h, "folder")]), h.h2([], ["Local Library"])]),
          h.div(
            [h.Class("library-actions"), h.Hidden(model.storageLocation !== "device")],
            [
              Button.view(
                {
                  onClick: Message.RequestedAddDialog(),
                  isDisabled: disabled,
                  toView: (attributes) => h.button([...attributes.button, h.Class("button primary")], [icon(h, "plus"), "Add files"]),
                },
                h,
              ),
            ],
          ),
        ],
      ),
      model.status === "" ? null : h.p([h.Role("status")], [model.status]),
      model.operation === "preview" ? button(h, "Cancel preview", Message.CancelledPreview()) : null,
      h.submodel({
        slotId: "library-location",
        model: model.tabs,
        view: LocationTabs.view,
        toParentMessage: (message) => Message.GotTabsMessage({ message }),
        viewInputs: {
          tabs: ["device", "cloud"],
          selectedValue: model.storageLocation,
          ariaLabel: "Storage location",
          isTabDisabled: () => model.operation !== "idle",
          toView: (render) =>
            h.div(
              [],
              [
                h.div(
                  [h.Class("flex flex-wrap items-center justify-between gap-x-4 gap-y-3 mb-3")],
                  [
                    h.div(
                      [...render.tablist],
                      render.tabs.map((tab) => h.button([...tab.tab], [tab.value === "device" ? "On this device" : "Cloud"])),
                    ),
                    model.storageLocation === "device" ? consent() : null,
                  ],
                ),
                ...render.tabs
                  .filter((tab) => tab.isActive)
                  .map((tab) =>
                    h.div(
                      [...tab.panel],
                      [
                        tab.value === "device"
                          ? device()
                          : h.section(
                              [],
                              [
                                h.h2([], ["Cloud is not available yet"]),
                                h.p(
                                  [],
                                  [
                                    "Service-provided cloud storage requires an account and Premium. Configuring your own cloud server will not require Premium. No files are uploaded or copied by this Library.",
                                  ],
                                ),
                              ],
                            ),
                      ],
                    ),
                  ),
              ],
            ),
        },
      }),
      h.submodel({ slotId: "library-preview", model: model.preview, view: Preview.view, toParentMessage: liftPreview }),
      h.submodel({
        slotId: "library-confirmation",
        model: model.dialog,
        view: Dialog.view,
        toParentMessage: liftDialog,
        viewInputs: {
          hasDescription: true,
          toView: (render) =>
            render.isVisible
              ? h.div(
                  [],
                  [
                    h.div([...render.backdrop, h.Class("dialog-backdrop")]),
                    h.dialog(
                      [...render.dialog, h.Class("library-dialog")],
                      [
                        h.div(
                          [...render.panel, h.Class("dialog-panel")],
                          [
                            h.h2([...render.title], [title]),
                            h.p(
                              [...render.description],
                              [
                                confirmation.kind === "review"
                                  ? "Review original edits before approving. Fingerprints were checked locally, including edits that keep size and modification time unchanged. Captured File values do not track later edits: reselect after changing an original. Nothing has been sent."
                                  : description,
                              ],
                            ),
                            confirmation.kind === "review"
                              ? h.ul(
                                  [],
                                  confirmation.reviewed.map((entry) =>
                                    h.keyed("li")(
                                      String(entry.previous.identifier),
                                      [],
                                      [
                                        h.strong([], [entry.current.name]),
                                        h.p([], [entry.changed ? "Changed since indexing or last approval" : "Unchanged since indexing or last approval"]),
                                        h.p(
                                          [],
                                          [
                                            `Previous: ${entry.previous.size} bytes, modified ${Option.match(DateTime.make(entry.previous.lastModified), {
                                              onNone: () => "unknown",
                                              onSome: DateTime.formatIso,
                                            })}. Current: ${entry.current.size} bytes, modified ${Option.match(DateTime.make(entry.current.lastModified), {
                                              onNone: () => "unknown",
                                              onSome: DateTime.formatIso,
                                            })}.`,
                                          ],
                                        ),
                                      ],
                                    ),
                                  ),
                                )
                              : confirmationDetail(),
                            confirmation.kind === "add"
                              ? h.div(
                                  [h.Class("dialog-form")],
                                  [
                                    h.submodel({
                                      slotId: "libraryFileDrop",
                                      model: model.fileDrop,
                                      view: FileDrop.view,
                                      toParentMessage: (message) =>
                                        Message.GotFileDropMessage({ message: Redacted.make(message), generationId: model.dropGeneration }),
                                      viewInputs: {
                                        multiple: Option.isNone(model.reconnect),
                                        isDisabled: disabled,
                                        toView: (attributes) =>
                                          h.label(
                                            [...attributes.root, h.Class("drop-zone")],
                                            [
                                              h.input([...attributes.input, h.Class("visually-hidden")]),
                                              Option.isNone(model.reconnect) ? "Choose or drop files to add to My files" : "Choose the original to reconnect",
                                            ],
                                          ),
                                      },
                                    }),
                                    button(
                                      h,
                                      "Choose durable file references (supported browsers)",
                                      Message.RequestedDurablePicker(),
                                      disabled || Option.isSome(model.reconnect),
                                    ),
                                    Option.isSome(model.reconnect)
                                      ? button(h, "Cancel reconnection", Message.CancelledReconnect(), model.operation !== "idle")
                                      : null,
                                  ],
                                )
                              : null,
                            confirmation.kind === "create"
                              ? h.div(
                                  [h.Class("dialog-form")],
                                  [
                                    Input.view(
                                      {
                                        id: "library-collection-name",
                                        value: Redacted.value(model.name),
                                        isDisabled: disabled,
                                        onInput: (name) => Message.ChangedCollectionName({ name: Redacted.make(name) }),
                                        toView: (attributes) =>
                                          h.div([], [h.label([...attributes.label], ["New collection name"]), h.input([...attributes.input])]),
                                      },
                                      h,
                                    ),
                                    button(
                                      h,
                                      "Create empty collection",
                                      Message.RequestedCreateCollection(),
                                      disabled || Redacted.value(model.name).trim().length === 0,
                                    ),
                                  ],
                                )
                              : null,
                            confirmation.kind === "manage"
                              ? h.div(
                                  [h.Class("dialog-form")],
                                  [
                                    button(
                                      h,
                                      `Reconnect ${confirmation.entry.name}`,
                                      Message.RequestedReconnect({ identifier: confirmation.entry.identifier }),
                                      disabled,
                                    ),
                                    collection.identifier === 0
                                      ? null
                                      : button(
                                          h,
                                          `Remove ${confirmation.entry.name} from collection`,
                                          Message.RequestedRemoveMember({ identifier: confirmation.entry.identifier }),
                                          disabled,
                                        ),
                                    button(
                                      h,
                                      `Forget ${confirmation.entry.name}`,
                                      Message.RequestedForgetFile({ identifier: confirmation.entry.identifier }),
                                      disabled,
                                    ),
                                  ],
                                )
                              : null,
                            confirmation.kind !== "add" && confirmation.kind !== "create" && confirmation.kind !== "manage"
                              ? button(
                                  h,
                                  confirmation.kind === "review" ? "Approve and share current versions" : actionLabel,
                                  Message.ConfirmedAction(),
                                  model.operation !== "idle" || (confirmation.kind === "review" && inputs.sharingDisabled),
                                )
                              : null,
                            h.button([...render.closeButton], ["Cancel"]),
                          ],
                        ),
                      ],
                    ),
                  ],
                )
              : null,
        },
      }),
    ],
  )
})
