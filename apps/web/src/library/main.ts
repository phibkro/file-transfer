import { DateTime, Effect, Option, Redacted, Schema } from "effect"
import { Command, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { HtmlBuilder } from "foldkit/html"
import { defineView } from "foldkit/submodel"
import { Button, Checkbox, Dialog, Fieldset, FileDrop, Input, Select, Switch, Tabs } from "@foldkit/ui"
import { privateValue } from "../privateValue.ts"
import * as Catalog from "../localLibrary.ts"

type Snapshot = Catalog.LibrarySnapshot

type Entry = Snapshot["files"][number]

type Review = readonly Catalog.ReviewedFile[]

type Action =
  | { readonly kind: "load" }
  | { readonly kind: "configure"; readonly enabled: boolean }
  | { readonly kind: "index"; readonly files: readonly File[]; readonly epoch: number; readonly reconnect: Entry | undefined }
  | { readonly kind: "picker"; readonly epoch: number }
  | { readonly kind: "create"; readonly name: string; readonly epoch: number }
  | { readonly kind: "add"; readonly collection: number; readonly files: readonly number[]; readonly epoch: number }
  | { readonly kind: "remove"; readonly collection: number; readonly file: number; readonly epoch: number }
  | { readonly kind: "forgetFile"; readonly file: number; readonly epoch: number }
  | { readonly kind: "forgetCollection"; readonly collection: number; readonly epoch: number }
  | { readonly kind: "reconnect"; readonly previous: Entry; readonly current: Catalog.IndexedVersion; readonly epoch: number }
  | { readonly kind: "review"; readonly entries: Snapshot["files"]; readonly collection: Catalog.LibraryCollection | undefined; readonly epoch: number }
  | { readonly kind: "approve"; readonly reviewed: Review; readonly collection: Catalog.LibraryCollection | undefined; readonly epoch: number }

type Result =
  | { readonly kind: "snapshot"; readonly snapshot: Snapshot }
  | { readonly kind: "review"; readonly reviewed: Review; readonly collection: Catalog.LibraryCollection | undefined; readonly epoch: number }
  | { readonly kind: "candidate"; readonly previous: Entry; readonly current: Catalog.IndexedVersion; readonly epoch: number }
  | { readonly kind: "share"; readonly snapshot: Snapshot; readonly files: readonly File[] }

type Confirmation =
  | { readonly kind: "none" }
  | { readonly kind: "disable" }
  | { readonly kind: "forgetFile"; readonly entry: Entry }
  | { readonly kind: "forgetCollection"; readonly collection: Catalog.LibraryCollection }
  | { readonly kind: "candidate"; readonly previous: Entry; readonly current: Catalog.IndexedVersion; readonly epoch: number }
  | { readonly kind: "review"; readonly reviewed: Review; readonly collection: Catalog.LibraryCollection | undefined; readonly epoch: number }

export const Model = Schema.Struct({
  snapshot: privateValue<Snapshot>(),
  collection: Schema.Int,
  selected: Schema.Array(Schema.Int),
  name: privateValue<string>(),
  confirmation: privateValue<Confirmation>(),
  reconnect: Schema.Option(Schema.Int),
  storageLocation: Schema.Literals(["device", "cloud"]),
  tabs: Tabs.Model,
  dialog: Dialog.Model,
  fileDrop: FileDrop.Model,
  busy: Schema.Boolean,
  generation: Schema.Int,
  status: Schema.String,
})

export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  GotTabsMessage: { message: Tabs.Message },
  GotDialogMessage: { message: Dialog.Message },
  GotFileDropMessage: { message: privateValue<FileDrop.Message>() },
  ChangedCollectionName: { name: privateValue<string>() },
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

/** Catalog mutations return the pre-edit snapshot. Read only after commit. */
const committedSnapshot = Effect.fnUntraced(function* (operation: Effect.Effect<Snapshot, Catalog.LibraryStorageError>) {
  yield* operation

  return yield* Catalog.readLibrary
})

const perform = Effect.fnUntraced(function* (action: Action): Effect.fn.Return<Result, Catalog.LibraryStorageError> {
  switch (action.kind) {
    case "load": {
      return { kind: "snapshot", snapshot: yield* Catalog.readLibrary }
    }

    case "configure": {
      return { kind: "snapshot", snapshot: yield* committedSnapshot(Catalog.configureCatalog(action.enabled)) }
    }

    case "index": {
      const indexed = yield* Catalog.indexCatalogFiles(action.files)

      if (action.reconnect !== undefined) {
        const current = indexed[0]

        if (current === undefined || indexed.length !== 1) {
          return yield* new Catalog.LibraryStorageError({ cause: "Choose exactly one original to reconnect" })
        }

        return { kind: "candidate", previous: action.reconnect, current, epoch: action.epoch }
      }

      return { kind: "snapshot", snapshot: yield* committedSnapshot(Catalog.rememberFiles(indexed, action.epoch)) }
    }

    case "picker": {
      return { kind: "snapshot", snapshot: yield* committedSnapshot(Catalog.rememberFiles(yield* Catalog.chooseCatalogFiles(true), action.epoch)) }
    }

    case "create": {
      return { kind: "snapshot", snapshot: yield* committedSnapshot(Catalog.createCollection(action.name, action.epoch)) }
    }

    case "add": {
      return { kind: "snapshot", snapshot: yield* committedSnapshot(Catalog.addToCollection(action.collection, action.files, action.epoch)) }
    }

    case "remove": {
      return { kind: "snapshot", snapshot: yield* committedSnapshot(Catalog.removeFromCollection(action.collection, action.file, action.epoch)) }
    }

    case "forgetFile": {
      return { kind: "snapshot", snapshot: yield* committedSnapshot(Catalog.deleteFile(action.file, action.epoch)) }
    }

    case "forgetCollection": {
      return { kind: "snapshot", snapshot: yield* committedSnapshot(Catalog.deleteCollection(action.collection, action.epoch)) }
    }

    case "reconnect": {
      return { kind: "snapshot", snapshot: yield* committedSnapshot(Catalog.reconnectFile(action.previous, action.current, action.epoch)) }
    }

    case "review": {
      return { kind: "review", reviewed: yield* Catalog.reviewCatalogFiles(action.entries), collection: action.collection, epoch: action.epoch }
    }

    case "approve": {
      const snapshot = yield* committedSnapshot(Catalog.approveVersions(action.reviewed, action.epoch, action.collection))

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

export const cancel = (model: Model): Update.Return<Model, Message> => ({
  model: { ...model, busy: false, generation: model.generation + 1 },
  commands: [RunLibraryAction.Interrupt(() => Message.CompletedCancelRunLibraryAction())],
})

const start = (model: Model, action: Action): Update.Return<Model, Message> =>
  model.busy
    ? { model }
    : {
        model: { ...model, busy: true, generation: model.generation + 1, status: "Working locally. No file content is being uploaded." },
        commands: [RunLibraryAction({ action: Redacted.make(action), generation: model.generation + 1 })],
      }

export const init = (): Update.Return<Model, Message> => ({
  model: {
    snapshot: Redacted.make({ enabled: false, epoch: 0, files: [], collections: [] }),
    collection: 0,
    selected: [],
    name: Redacted.make(""),
    confirmation: Redacted.make({ kind: "none" }),
    reconnect: Option.none(),
    storageLocation: "device",
    tabs: Tabs.init({ id: "library-location" }),
    dialog: Dialog.init({ id: "library-confirmation" }),
    fileDrop: FileDrop.init({ id: "library-files" }),
    busy: false,
    generation: 0,
    status: "Loading local Library.",
  },
})

export const boot = (): Update.Return<Model, Message> => start(init().model, { kind: "load" })

const liftDialog = (message: Dialog.Message): Message => Message.GotDialogMessage({ message })

const foldDialogOut =
  (out: Dialog.OutMessage) =>
  (model: Model): Update.Return<Model, Message> =>
    out._tag === "Closed" ? { model: { ...model, confirmation: Redacted.make({ kind: "none" }) } } : { model }

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

const foldDrop = Update.foldChild({
  update: FileDrop.update,
  read: (model: Model) => Option.some(model.fileDrop),
  write: (model: Model, fileDrop: FileDrop.Model): Model => ({ ...model, fileDrop }),
  toParentMessage: (message: FileDrop.Message) => Message.GotFileDropMessage({ message: Redacted.make(message) }),
  foldOutMessage:
    (out: FileDrop.OutMessage) =>
    (model: Model): Return => {
      const snapshot = Redacted.value(model.snapshot)

      if (out._tag === "RejectedNonFiles") {
        return { model: { ...model, status: "Choose or drop files, not text or folders." } }
      }

      if (!snapshot.enabled || model.busy) {
        return { model }
      }

      const reconnect = snapshot.files.find((entry) => Option.contains(model.reconnect, entry.identifier))

      return start(model, { kind: "index", files: out.files, epoch: snapshot.epoch, reconnect })
    },
})

export const update = (model: Model, incoming: Message): Return => {
  const snapshot = Redacted.value(model.snapshot)
  const collection = snapshot.collections.find((entry) => entry.identifier === model.collection)
  const { epoch } = snapshot

  return Message.match<Return>(incoming, {
    GotTabsMessage: (message) => (model.busy ? { model } : foldTabs(model, message.message)),
    GotDialogMessage: (message) => foldDialog(model, message.message),
    GotFileDropMessage: (message) => foldDrop(model, Redacted.value(message.message)),
    ChangedCollectionName: (message) => ({ model: { ...model, name: message.name } }),
    SelectedCollection: (message) => ({ model: { ...model, collection: message.identifier, selected: [] } }),
    ToggledFile: (message) => ({
      model: {
        ...model,
        selected: model.selected.includes(message.identifier)
          ? model.selected.filter((id) => id !== message.identifier)
          : [...model.selected, message.identifier],
      },
    }),
    RequestedReload: () => start(model, { kind: "load" }),
    RequestedEnable: () => start(model, { kind: "configure", enabled: true }),
    RequestedDisable: () => (model.busy ? { model } : ask(model, { kind: "disable" })),
    RequestedCreateCollection: () =>
      snapshot.enabled && Redacted.value(model.name).trim().length > 0
        ? start(model, { kind: "create", name: Redacted.value(model.name).trim(), epoch })
        : { model },
    RequestedDurablePicker: () => (snapshot.enabled ? start(model, { kind: "picker", epoch }) : { model }),
    RequestedAddMembers: (message) =>
      snapshot.enabled && model.selected.length > 0 && message.identifier !== 0
        ? start(model, { kind: "add", collection: message.identifier, files: model.selected, epoch })
        : { model },
    RequestedRemoveMember: (message) =>
      collection === undefined ? { model } : start(model, { kind: "remove", collection: collection.identifier, file: message.identifier, epoch }),
    RequestedForgetFile: (message) => {
      const entry = snapshot.files.find((file) => file.identifier === message.identifier)

      return entry === undefined || model.busy ? { model } : ask(model, { kind: "forgetFile", entry })
    },
    RequestedForgetCollection: () => (collection === undefined || model.busy ? { model } : ask(model, { kind: "forgetCollection", collection })),
    RequestedReconnect: (message) => ({
      model: {
        ...model,
        reconnect: Option.some(message.identifier),
        status: "Choose exactly one original in the file chooser below. Review and confirm before replacing its reference.",
      },
    }),
    CancelledReconnect: () => ({ model: { ...model, reconnect: Option.none(), status: "Reconnection cancelled. The saved reference is unchanged." } }),
    RequestedReview: () => {
      const entries = snapshot.files.filter((entry) => model.selected.includes(entry.identifier))

      return entries.length === 0 ? { model } : start(model, { kind: "review", entries, collection, epoch })
    },
    RequestedReviewCollection: () => {
      const current = collection ?? Catalog.deriveMyFiles(snapshot)
      const entries = snapshot.files.filter((entry) => current.fileIdentifiers.includes(entry.identifier))

      return entries.length === 0 ? { model } : start(model, { kind: "review", entries, collection: current, epoch })
    },
    ConfirmedAction: () => {
      if (model.busy) {
        return { model }
      }

      const confirmation = Redacted.value(model.confirmation)
      let action: Action

      switch (confirmation.kind) {
        case "none": {
          return { model }
        }

        case "disable": {
          action = { kind: "configure", enabled: false }
          break
        }

        case "forgetFile": {
          action = { kind: "forgetFile", file: confirmation.entry.identifier, epoch }
          break
        }

        case "forgetCollection": {
          action = { kind: "forgetCollection", collection: confirmation.collection.identifier, epoch }
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
      if (!model.busy || message.generation !== model.generation) {
        return { model }
      }

      const result = Redacted.value(message.result)
      const ready: Model = { ...model, busy: false, status: "Library updated on this device only." }

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

      return result.kind === "share" ? { model: next, outMessage: OutMessage.RequestedQuickShare({ files: Redacted.make(result.files) }) } : { model: next }
    },
    FailedLibraryAction: (message) =>
      message.generation === model.generation
        ? {
            model: {
              ...model,
              busy: false,
              status:
                "Could not complete this local operation. Permission may be denied, the browser may not support durable references, or the catalog changed in another tab. Reload the Library and review again, or reselect the original. Nothing was shared.",
            },
          }
        : { model },
    CompletedCancelRunLibraryAction: () => ({ model: { ...model, busy: false, generation: model.generation + 1 } }),
  })
}

const button = (h: HtmlBuilder<Message>, label: string, message: Message, disabled = false) =>
  Button.view({ onClick: message, isDisabled: disabled, toView: (attributes) => h.button([...attributes.button], [label]) }, h)

export const view = defineView<Model, Message>((model, h) => {
  const snapshot = Redacted.value(model.snapshot)

  const collection =
    model.collection === 0
      ? Catalog.deriveMyFiles(snapshot)
      : (snapshot.collections.find((entry) => entry.identifier === model.collection) ?? Catalog.deriveMyFiles(snapshot))

  const disabled = model.busy || !snapshot.enabled
  const files = snapshot.files.filter((entry) => collection.fileIdentifiers.includes(entry.identifier))

  const device = () =>
    h.section(
      [],
      [
        h.h2([], ["On this device"]),
        h.p(
          [],
          [
            "Your Library indexes original file references and metadata on this device. Adding files does not upload or copy their contents. Local edits affect future shares.",
          ],
        ),
        h.p(
          [],
          [
            "Standard file choosing keeps a captured File for this page only, not a live filesystem handle. After editing an original, reselect it with Reconnect before reviewing a future share. After reopening this page, reselect originals to reconnect. Durable references require browser support and permission.",
          ],
        ),
        Switch.view(
          {
            id: "library-consent",
            isChecked: snapshot.enabled,
            isDisabled: model.busy,
            onToggle: (enabled) => (enabled ? Message.RequestedEnable() : Message.RequestedDisable()),
            toView: (attributes) =>
              h.div(
                [],
                [
                  h.button([...attributes.button], [snapshot.enabled ? "Remembering on" : "Remembering off"]),
                  h.span([...attributes.label], ["Remember files on this device"]),
                ],
              ),
          },
          h,
        ),
        h.p(
          [],
          [
            snapshot.enabled
              ? "Remembering is enabled. Only metadata and supported references are saved locally."
              : "Remembering is off by default. My files is available without storing any file data. Quick Share remains available without opting in.",
          ],
        ),
        Select.view(
          {
            id: "library-collection",
            value: String(collection.identifier),
            isDisabled: model.busy,
            onChange: (value) =>
              Message.SelectedCollection({
                identifier:
                  [Catalog.deriveMyFiles(snapshot), ...snapshot.collections].find((entry) => String(entry.identifier) === value)?.identifier ??
                  model.collection,
              }),
            toView: (attributes) =>
              h.div(
                [],
                [
                  h.label([...attributes.label], ["Collection"]),
                  h.select(
                    [...attributes.select],
                    [Catalog.deriveMyFiles(snapshot), ...snapshot.collections].map((entry) =>
                      h.keyed("option")(String(entry.identifier), [h.Value(String(entry.identifier))], [`${entry.name} (${entry.fileIdentifiers.length})`]),
                    ),
                  ),
                ],
              ),
          },
          h,
        ),
        h.h3([], [collection.name]),
        collection.identifier === 0
          ? h.p([], ["My files includes every indexed file automatically and cannot be deleted."])
          : button(h, "Forget collection", Message.RequestedForgetCollection(), disabled),
        Fieldset.view(
          {
            id: "library-create-collection",
            isDisabled: disabled,
            toView: (attributes) =>
              h.fieldset(
                [...attributes.fieldset],
                [
                  h.legend([...attributes.legend], ["Create a collection"]),
                  Input.view(
                    {
                      id: "library-collection-name",
                      value: Redacted.value(model.name),
                      isDisabled: disabled,
                      onInput: (name) => Message.ChangedCollectionName({ name: Redacted.make(name) }),
                      toView: (input) => h.div([], [h.label([...input.label], ["New collection name"]), h.input([...input.input])]),
                    },
                    h,
                  ),
                  button(h, "Create empty collection", Message.RequestedCreateCollection(), disabled || Redacted.value(model.name).trim().length === 0),
                ],
              ),
          },
          h,
        ),
        Option.isNone(model.reconnect)
          ? null
          : h.div(
              [h.Role("status")],
              [
                h.p([], ["Reconnect: choose one original below, then confirm the replacement."]),
                button(h, "Cancel reconnection", Message.CancelledReconnect(), model.busy),
              ],
            ),
        h.submodel({
          slotId: "library-file-drop",
          model: model.fileDrop,
          view: FileDrop.view,
          toParentMessage: (message) => Message.GotFileDropMessage({ message: Redacted.make(message) }),
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
        button(h, "Choose durable file references (supported browsers)", Message.RequestedDurablePicker(), disabled || Option.isSome(model.reconnect)),
        files.length === 0
          ? h.p([], ["This collection is empty. Add files to My files, select them, then add them to a collection."])
          : h.ul(
              [h.Class("catalog-list")],
              files.map((entry) =>
                h.keyed("li")(
                  String(entry.identifier),
                  [],
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
                              h.button([...attributes.checkbox], [model.selected.includes(entry.identifier) ? "Selected" : "Select"]),
                              h.span([...attributes.label], [entry.name]),
                            ],
                          ),
                      },
                      h,
                    ),
                    h.p(
                      [],
                      [
                        `${String(entry.size)} bytes. ${
                          entry.handle === undefined ? "Reselect after edits or reopening this page." : "Original reference: access checked before sharing."
                        }`,
                      ],
                    ),
                    button(h, "Reconnect original", Message.RequestedReconnect({ identifier: entry.identifier }), disabled),
                    collection.identifier === 0
                      ? null
                      : button(h, "Remove from collection", Message.RequestedRemoveMember({ identifier: entry.identifier }), disabled),
                    button(h, "Forget file", Message.RequestedForgetFile({ identifier: entry.identifier }), disabled),
                  ],
                ),
              ),
            ),
        h.p([], [`${String(model.selected.length)} selected`]),
        button(h, "Review selected files before sharing", Message.RequestedReview(), disabled || model.selected.length === 0),
        button(h, "Review collection before sharing", Message.RequestedReviewCollection(), disabled || files.length === 0),
        ...snapshot.collections.map((entry) =>
          button(h, `Add selected to ${entry.name}`, Message.RequestedAddMembers({ identifier: entry.identifier }), disabled || model.selected.length === 0),
        ),
      ],
    )

  const confirmation = Redacted.value(model.confirmation)

  const confirmationTitle = confirmation.kind === "review" ? "Review current versions" : "Confirm forgetting"
  const title = confirmation.kind === "candidate" ? "Confirm reconnection" : confirmationTitle

  const description =
    confirmation.kind === "candidate"
      ? "Confirm that this is the intended original. Reconnecting changes its future shares, not an existing share."
      : "Only Library metadata and references will be forgotten. Your original files are never deleted."

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

      case "disable":
      case "none":
      case "review": {
        return null
      }
    }
  }

  return h.div(
    [h.Class("library-page"), h.AriaBusy(model.busy)],
    [
      h.h1([], ["Library"]),
      h.p([h.Role("status")], [model.status]),
      button(h, "Reload Library", Message.RequestedReload(), model.busy),
      h.submodel({
        slotId: "library-location",
        model: model.tabs,
        view: LocationTabs.view,
        toParentMessage: (message) => Message.GotTabsMessage({ message }),
        viewInputs: {
          tabs: ["device", "cloud"],
          selectedValue: model.storageLocation,
          ariaLabel: "Storage location",
          isTabDisabled: () => model.busy,
          toView: (render) =>
            h.div(
              [],
              [
                h.div(
                  [...render.tablist],
                  render.tabs.map((tab) => h.button([...tab.tab], [tab.value === "device" ? "On this device" : "Cloud"])),
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
                            button(
                              h,
                              confirmation.kind === "review" ? "Approve and share current versions" : actionLabel,
                              Message.ConfirmedAction(),
                              model.busy,
                            ),
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
