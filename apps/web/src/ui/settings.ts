import { Button, Disclosure, Switch, Tabs } from "@foldkit/ui"
import { Effect, Option, Schema } from "effect"
import { Command, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineView } from "foldkit/submodel"
import { directAllowed, setDirectAllowed } from "../directSettings.ts"
import { hasOfferedRemoval, removeOfferedFiles } from "../storagePanel.ts"
import { storageUse, sweepStaleTransfers } from "../storage.ts"
import { formatSize } from "../view.ts"

const Use = Schema.Struct({
  receivedBytes: Schema.Finite,
  inUse: Schema.Finite,
  stale: Schema.Finite,
  usage: Schema.UndefinedOr(Schema.Finite),
  quota: Schema.UndefinedOr(Schema.Finite),
  removable: Schema.Boolean,
})

export const Model = Schema.Struct({
  tabs: Tabs.Model,
  selected: Schema.Literals(["direct", "storage"]),
  direct: Schema.Boolean,
  directLoaded: Schema.Boolean,
  directDirty: Schema.Boolean,
  directSaving: Schema.Boolean,
  open: Schema.Boolean,
  confirm: Schema.Boolean,
  busy: Schema.Boolean,
  use: Schema.Option(Use),
  status: Schema.String,
})

export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  GotTabsMessage: { message: Tabs.Message },
  ToggledOpen: { open: Schema.Boolean },
  ToggledDirect: { allowed: Schema.Boolean },
  SavedDirect: {},
  RequestedClear: {},
  CancelledClear: {},
  ConfirmedClear: {},
  Loaded: { use: Use, direct: Schema.Boolean },
  Cleared: { use: Use },
  Failed: {},
})

export type Message = typeof Message.Type

const SettingsTabs = Tabs.create<"direct" | "storage">()

const LoadBrowserSettings = Command.define("LoadBrowserSettings", {
  messages: [Message.Loaded, Message.Failed],
  execute: Effect.tryPromise({ try: async () => ({ ...(await storageUse()), removable: hasOfferedRemoval() }), catch: () => undefined }).pipe(
    Effect.map((use) => Message.Loaded({ use, direct: directAllowed() })),
    Effect.orElseSucceed(() => Message.Failed()),
  ),
})

const SetDirectPreference = Command.define("SetDirectPreference", {
  args: { allowed: Schema.Boolean },
  messages: [Message.SavedDirect],
  execute: ({ allowed }) =>
    Effect.sync(() => {
      setDirectAllowed(allowed)

      return Message.SavedDirect()
    }),
})

const ClearReceivedFiles = Command.define("ClearReceivedFiles", {
  messages: [Message.Cleared, Message.Failed],
  execute: Effect.tryPromise({
    try: async () => {
      await removeOfferedFiles()
      await sweepStaleTransfers()

      return { ...(await storageUse()), removable: hasOfferedRemoval() }
    },
    catch: () => undefined,
  }).pipe(
    Effect.map((use) => Message.Cleared({ use })),
    Effect.orElseSucceed(() => Message.Failed()),
  ),
})

export const init = (): Update.Return<Model, Message> => ({
  model: {
    tabs: Tabs.init({ id: "settings-tabs" }),
    selected: "direct",
    direct: true,
    directLoaded: false,
    directDirty: false,
    directSaving: false,
    open: false,
    confirm: false,
    busy: false,
    use: Option.none(),
    status: "",
  },
})

export const boot = (): Update.Return<Model, Message> => ({ ...init(), commands: [LoadBrowserSettings()] })

const foldTabs = Update.foldChild({
  update: SettingsTabs.update,
  read: (model: Model) => Option.some(model.tabs),
  write: (model, tabs) => ({ ...model, tabs }),
  toParentMessage: (message) => Message.GotTabsMessage({ message }),
  foldOutMessage: (out) => (model) => ({ model: { ...model, selected: out.value } }),
})

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match(message, {
    GotTabsMessage: ({ message: child }) => foldTabs(model, child),
    ToggledOpen: ({ open }) => (open ? { model: { ...model, open }, commands: [LoadBrowserSettings()] } : { model: { ...model, open } }),
    ToggledDirect: ({ allowed }) =>
      model.directSaving || !model.directLoaded
        ? { model }
        : { model: { ...model, direct: allowed, directDirty: true, directSaving: true }, commands: [SetDirectPreference({ allowed })] },
    SavedDirect: () => ({ model: { ...model, directSaving: false } }),
    RequestedClear: () => ({ model: { ...model, confirm: true }, commands: [LoadBrowserSettings()] }),
    CancelledClear: () => ({ model: { ...model, confirm: false } }),
    ConfirmedClear: () => (model.busy ? { model } : { model: { ...model, busy: true, status: "Removing received files." }, commands: [ClearReceivedFiles()] }),
    Loaded: ({ use, direct }) => ({ model: { ...model, use: Option.some(use), direct: model.directDirty ? model.direct : direct, directLoaded: true } }),
    Cleared: ({ use }) => ({ model: { ...model, use: Option.some(use), confirm: false, busy: false, status: "" } }),
    Failed: () => ({ model: { ...model, busy: false, status: "Could not read or clear browser storage." } }),
  })

export const view = defineView<Model, Message>((model, h) =>
  Disclosure.view(
    {
      id: "browser-settings",
      isOpen: model.open,
      onToggle: (open) => Message.ToggledOpen({ open }),
      toView: (disclosure) =>
        h.section(
          [h.Class("browser-settings")],
          [
            h.button([...disclosure.button, h.Class("button")], ["Browser settings"]),
            ...(model.open
              ? [
                  h.div(
                    [...disclosure.panel, h.Class("settings-panel")],
                    [
                      h.submodel({
                        slotId: "tabs",
                        model: model.tabs,
                        view: SettingsTabs.view,
                        toParentMessage: (message) => Message.GotTabsMessage({ message }),
                        viewInputs: {
                          tabs: ["direct", "storage"],
                          selectedValue: model.selected,
                          ariaLabel: "Browser settings",
                          toView: ({ tablist, tabs }) =>
                            h.div(
                              [],
                              [
                                h.div(
                                  [...tablist, h.Class("mode-tabs settings-tabs")],
                                  tabs.map((tab) => h.button(tab.tab, [tab.value === "direct" ? "Direct connections" : "Storage in this browser"])),
                                ),
                                ...tabs
                                  .filter((tab) => tab.isActive)
                                  .map((tab) =>
                                    h.div(
                                      tab.panel,
                                      tab.value === "direct"
                                        ? [
                                            Switch.view(
                                              {
                                                id: "direct-connections",
                                                isChecked: model.direct,
                                                isDisabled: !model.directLoaded || model.directSaving,
                                                onToggle: (allowed) => Message.ToggledDirect({ allowed }),
                                                toView: (a) =>
                                                  h.div(
                                                    [],
                                                    [
                                                      h.button(a.button, [model.direct ? "On" : "Off"]),
                                                      h.span(a.label, ["Connect directly to the other side when possible"]),
                                                    ],
                                                  ),
                                              },
                                              h,
                                            ),
                                            h.p(
                                              [h.Class("direct-note")],
                                              [
                                                "Direct is faster and leaves the server less to carry, and files stay end-to-end encrypted either way. The other side learns this device's network (IP) address. Turned off, transfers use the relay. Applies to transfers you start or open from now on.",
                                              ],
                                            ),
                                          ]
                                        : [
                                            h.p(
                                              [h.Class("storage-text"), h.Role("status")],
                                              [
                                                Option.isSome(model.use)
                                                  ? `Received files stored here: ${formatSize(model.use.value.receivedBytes)}.${model.use.value.usage !== undefined && model.use.value.quota !== undefined ? ` This site uses ${formatSize(model.use.value.usage)} of browser storage, with ${formatSize(Math.max(0, model.use.value.quota - model.use.value.usage))} available.` : ""} Files of transfers still in use are kept.`
                                                  : "Checking storage.",
                                              ],
                                            ),
                                            ...(model.confirm
                                              ? [
                                                  h.p(
                                                    [],
                                                    [
                                                      `Delete ${Option.isSome(model.use) ? formatSize(model.use.value.receivedBytes) : "stored"} received files from this browser?`,
                                                    ],
                                                  ),
                                                  Button.view(
                                                    {
                                                      onClick: Message.ConfirmedClear(),
                                                      isDisabled: model.busy,
                                                      toView: (a) => h.button([...a.button, h.Class("button")], ["Delete"]),
                                                    },
                                                    h,
                                                  ),
                                                  Button.view(
                                                    {
                                                      onClick: Message.CancelledClear(),
                                                      toView: (a) => h.button([...a.button, h.Class("button")], ["Cancel"]),
                                                    },
                                                    h,
                                                  ),
                                                ]
                                              : [
                                                  Button.view(
                                                    {
                                                      onClick: Message.RequestedClear(),
                                                      isDisabled: Option.isNone(model.use) || !(model.use.value.stale > 0 || model.use.value.removable),
                                                      toView: (a) => h.button([...a.button, h.Class("button")], ["Clear stored files"]),
                                                    },
                                                    h,
                                                  ),
                                                ]),
                                            h.p([], ["Files you saved to your device are not affected."]),
                                          ],
                                    ),
                                  ),
                              ],
                            ),
                        },
                      }),
                      h.p([h.Role("status")], [model.status]),
                    ],
                  ),
                ]
              : []),
          ],
        ),
    },
    h,
  ),
)
