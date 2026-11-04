import { Data, Effect, Option, Queue, Redacted, Schema, Stream } from "effect"
import { Command, ManagedResource, Submodel, Subscription, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { Button, Progress } from "@foldkit/ui"
import { privateValue } from "../privateValue.ts"
import { formatSize } from "../view.ts"
import { createRecipientSession } from "../recipient.ts"
import type { RecipientSnapshot } from "../recipient.ts"
import * as Name from "../ui/name.ts"
import * as Preview from "../preview/main.ts"
import { ownDownloads } from "./downloads.ts"
import { publishReport } from "../report.ts"
import { offerRemoval } from "../storagePanel.ts"

interface Requirements {
  readonly roomIdentifier: string
  readonly fragment: string
}

const RecipientSession = ManagedResource.tag<Effect.Success<ReturnType<typeof ownDownloads>>>()("RecipientSession")

type RecipientSessionService = ManagedResource.ServiceOf<typeof RecipientSession>

export type Services = RecipientSessionService

export const Model = Schema.Struct({
  requirements: Schema.Option(privateValue<Requirements>()),
  snapshot: Schema.Option(privateValue<RecipientSnapshot>()),
  names: Schema.Array(Name.Model),
  preview: Preview.Model,
  acquired: Schema.Boolean,
  saveStatus: Schema.String,
})

export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ReceivedSnapshot: { snapshot: privateValue<RecipientSnapshot>() },
  GotNameMessage: { id: Schema.String, message: privateValue<Name.Message>() },
  GotPreviewMessage: { message: privateValue<Preview.Message>() },
  RequestedPreview: { index: Schema.Int },
  RequestedAccept: {},
  RequestedDecline: {},
  RequestedSave: { index: Schema.Int },
  RequestedSaveAll: {},
  RequestedRemoveAll: {},
  CompletedRecipientAction: {},
  FailedRecipientAction: {},
  CompletedSaveAll: { result: Schema.Literals(["saved", "cancelled", "failed"]) },
  AcquiredRecipientSession: {},
  ReleasedRecipientSession: {},
  FailedRecipientSession: {},
})

export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, RecipientSessionService>

export const init = (): Return => ({
  model: { requirements: Option.none(), snapshot: Option.none(), names: [], preview: Preview.init().model, acquired: false, saveStatus: "" },
})

export const boot = (roomIdentifier: string, fragment: Redacted.Redacted): Return => ({
  model: { ...init().model, requirements: Option.some(Redacted.make({ roomIdentifier, fragment: Redacted.value(fragment) })) },
})

type Action =
  | { readonly kind: "accept" | "decline" | "removeAll" }
  | { readonly kind: "markSaved"; readonly fileIdentifier: number }
  | { readonly kind: "rename"; readonly index: number; readonly name: string }

class RecipientActionError extends Data.TaggedError("RecipientActionError")<{ readonly reason: string }> {}

const RunRecipientAction = Command.define("RunRecipientAction", {
  args: { action: privateValue<Action>() },
  messages: [Message.CompletedRecipientAction, Message.FailedRecipientAction],
  execute: ({ action }) =>
    RecipientSession.get.pipe(
      Effect.flatMap((session) =>
        Effect.tryPromise({
          try: async () => {
            const value = Redacted.value(action)

            switch (value.kind) {
              case "accept": {
                await session.accept()

                break
              }

              case "decline": {
                session.decline()

                break
              }

              case "markSaved": {
                session.markSaved(value.fileIdentifier)

                break
              }

              case "removeAll": {
                await session.removeAll()

                break
              }

              case "rename": {
                session.rename(value.index, value.name)

                break
              }
            }
          },
          catch: () => new RecipientActionError({ reason: "operation-failed" }),
        }),
      ),
      Effect.as(Message.CompletedRecipientAction()),
      Effect.catchTags({
        RecipientActionError: () => Effect.succeed(Message.FailedRecipientAction()),
        ResourceNotAvailable: () => Effect.succeed(Message.FailedRecipientAction()),
      }),
    ),
})

const SaveRecipientFiles = Command.define("SaveRecipientFiles", {
  messages: [Message.CompletedSaveAll],
  execute: RecipientSession.get.pipe(
    Effect.flatMap((session) => session.saveAll.pipe(Effect.map((result) => Message.CompletedSaveAll({ result })))),
    Effect.catchTag("ResourceNotAvailable", () => Effect.succeed(Message.CompletedSaveAll({ result: "failed" }))),
  ),
})

const run = (model: Model, action: Action): Return => ({ model, commands: [RunRecipientAction({ action: Redacted.make(action) })] })
const liftPreview = (message: Preview.Message): Message => Message.GotPreviewMessage({ message: Redacted.make(message) })

const foldPreview = Update.foldChild({
  update: Preview.update,
  read: (model: Model) => Option.some(model.preview),
  write: (model: Model, preview: Preview.Model): Model => ({ ...model, preview }),
  toParentMessage: liftPreview,
})

const openPreview = (model: Model, file: File, name: string): Return =>
  Update.foldChildStep({
    update: (preview: Preview.Model) => Preview.open(preview, Redacted.make({ file, name })),
    read: (parent: Model) => Option.some(parent.preview),
    write: (parent: Model, preview: Preview.Model): Model => ({ ...parent, preview }),
    toParentMessage: liftPreview,
  })(model)

const foldName = (model: Model, id: string, message: Name.Message): Return => {
  const index = model.names.findIndex((name) => name.identifier === id)
  const snapshot = Option.isSome(model.snapshot) ? Redacted.value(model.snapshot.value) : undefined
  const file = snapshot?.files[index]

  if (snapshot === undefined || file === undefined) {
    return { model }
  }

  return Update.foldChild({
    update: (child: Name.Model, childMessage: Name.Message) =>
      Name.update(child, childMessage, {
        name: Redacted.make(file.name),
        names: snapshot.files.map((entry) => entry.name),
        index,
        canRename: !snapshot.filesRemoved,
      }),
    read: (parent: Model) => Option.fromNullishOr(parent.names.find((name) => name.identifier === id)),
    write: (parent: Model, child: Name.Model): Model => ({ ...parent, names: parent.names.map((current) => (current.identifier === id ? child : current)) }),
    toParentMessage: (childMessage: Name.Message) => Message.GotNameMessage({ id, message: Redacted.make(childMessage) }),
    foldOutMessage:
      (out: Name.OutMessage) =>
      (parent: Model): Return =>
        run(parent, { kind: "rename", index, name: Redacted.value(out.name) }),
  })(model, message)
}

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ReceivedSnapshot: ({ snapshot }) => ({
      model: {
        ...model,
        snapshot: Option.some(snapshot),
        names: Redacted.value(snapshot).files.map((_, index) => model.names[index] ?? Name.init(`recipient-name-${index}`)),
      },
    }),
    GotNameMessage: ({ id, message: child }) => foldName(model, id, Redacted.value(child)),
    GotPreviewMessage: ({ message: child }) => foldPreview(model, Redacted.value(child)),
    RequestedPreview: ({ index }) => {
      const file = Option.isSome(model.snapshot) ? Redacted.value(model.snapshot.value).files[index] : undefined

      return file?.file === undefined ? { model } : openPreview(model, file.file, file.name)
    },
    RequestedAccept: () => {
      const snapshot = Option.isSome(model.snapshot) ? Redacted.value(model.snapshot.value) : undefined

      return snapshot?.phase === "Reviewing" && !snapshot.spaceChecking && snapshot.spaceShortfall === undefined ? run(model, { kind: "accept" }) : { model }
    },
    RequestedDecline: () =>
      Option.isSome(model.snapshot) && Redacted.value(model.snapshot.value).phase === "Reviewing" ? run(model, { kind: "decline" }) : { model },
    RequestedSave: ({ index }) => run(model, { kind: "markSaved", fileIdentifier: index }),
    RequestedSaveAll: () =>
      Option.isSome(model.snapshot) && Redacted.value(model.snapshot.value).phase === "Completed" && !Redacted.value(model.snapshot.value).filesRemoved
        ? { model, commands: [SaveRecipientFiles()] }
        : { model },
    RequestedRemoveAll: () =>
      Option.isSome(model.snapshot) && Redacted.value(model.snapshot.value).phase === "Completed" && !Redacted.value(model.snapshot.value).filesRemoved
        ? run(model, { kind: "removeAll" })
        : { model },
    CompletedRecipientAction: () => ({ model }),
    FailedRecipientAction: () => ({ model: { ...model, saveStatus: "The requested action could not be completed." } }),
    CompletedSaveAll: ({ result }) => ({
      model: {
        ...model,
        saveStatus: {
          saved: "Downloads started or saved to your chosen folder.",
          failed: "Some files could not be saved. Use the links above instead.",
          cancelled: "",
        }[result],
      },
    }),
    AcquiredRecipientSession: () => ({ model: { ...model, acquired: true } }),
    ReleasedRecipientSession: () => ({ model: { ...model, acquired: false } }),
    FailedRecipientSession: () => ({ model: { ...model, saveStatus: "Could not start the transfer." } }),
  })

export const managedResources = ManagedResource.make<Model, Message>()((entry) => ({
  recipientSession: entry(Schema.Option(privateValue<Requirements>()), {
    resource: RecipientSession,
    modelToMaybeRequirements: (model) => model.requirements,
    acquire: (requirements) =>
      Effect.suspend(() => {
        const value = Redacted.value(requirements)

        return ownDownloads(createRecipientSession(value.roomIdentifier, value.fragment))
      }),
    release: (session) => session.dispose,
    onAcquired: () => Message.AcquiredRecipientSession(),
    onReleased: () => Message.ReleasedRecipientSession(),
    onAcquireError: () => Message.FailedRecipientSession(),
  }),
}))

export const subscriptions = Subscription.make<Model, Message, RecipientSessionService>()((entry) => ({
  recipientSnapshots: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ active: model.acquired }),
      dependenciesToStream: ({ active }) =>
        Stream.when(
          Stream.unwrap(
            RecipientSession.get.pipe(
              Effect.map((session) =>
                Stream.callback<Message>((queue) =>
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      let offered = false

                      const unsubscribe = session.subscribe((snapshot) => {
                        const shouldOffer = snapshot.phase === "Completed" && !snapshot.filesRemoved

                        if (shouldOffer !== offered) {
                          offered = shouldOffer
                          offerRemoval(shouldOffer ? session.removeAll : undefined)
                        }

                        const files = snapshot.files.flatMap((file) => (file.file === undefined ? [] : [file.file]))
                        publishReport({
                          status: snapshot.status,
                          progress: snapshot.progress,
                          path: snapshot.path,
                          summary: snapshot.summary,
                          unsavedFiles: snapshot.unsavedFiles,
                          failure: snapshot.failure,
                          failureDetail: snapshot.failureDetail,
                          spaceShortfall: snapshot.spaceShortfall,
                          files,
                        })
                        Queue.offerUnsafe(queue, Message.ReceivedSnapshot({ snapshot: Redacted.make(snapshot) }))
                      })

                      return () => {
                        unsubscribe()

                        if (offered) {
                          offerRemoval(undefined)
                        }
                      }
                    }),
                    (unsubscribe) => Effect.sync(unsubscribe),
                  ).pipe(Effect.flatMap(() => Effect.never)),
                ),
              ),
              Effect.catchTag("ResourceNotAvailable", () => Effect.succeed(Stream.empty)),
            ),
          ),
          Effect.sync(() => active),
        ),
    },
  ),
}))

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const snapshot = Option.isSome(model.snapshot) ? Redacted.value(model.snapshot.value) : undefined
  const files = snapshot?.files ?? []

  const button = (label: string, message: Message, disabled = false) =>
    Button.view({ onClick: message, isDisabled: disabled, toView: (attributes) => h.button(attributes.button, [label]) }, h)

  return h.section(
    [h.Attribute("aria-labelledby", "receive-heading")],
    [
      h.h1([h.Id("receive-heading")], ["Receive files"]),
      h.p([h.Class("status"), h.Role("status")], [snapshot?.statusText ?? "Connecting."]),
      h.p([h.Class("save-all-status"), h.Role("status")], [model.saveStatus]),
      h.ul(
        [h.Class(snapshot?.phase === "Completed" ? "file-list downloads" : "file-list")],
        files.map((file, index) => {
          const name = model.names[index]

          return h.li(
            [],
            [
              ...(name === undefined
                ? []
                : [
                    h.submodel({
                      slotId: name.identifier,
                      model: name,
                      view: Name.view,
                      viewInputs: {
                        name: Redacted.make(file.name),
                        names: files.map((entry) => entry.name),
                        index,
                        canRename: snapshot?.filesRemoved !== true,
                      },
                      toParentMessage: (message) => Message.GotNameMessage({ id: name.identifier, message: Redacted.make(message) }),
                    }),
                  ]),
              h.span([h.Class("size")], [formatSize(file.size)]),
              ...(file.file === undefined || file.url === undefined || snapshot?.filesRemoved === true
                ? []
                : [
                    h.a(
                      [
                        h.Href(file.url),
                        h.Attribute("download", file.name.split("/").join("_")),
                        h.Class("save"),
                        h.Attribute("aria-label", `Save ${file.name}`),
                        h.OnClick(Message.RequestedSave({ index })),
                      ],
                      ["Save"],
                    ),
                    button(`Preview ${file.name}`, Message.RequestedPreview({ index })),
                  ]),
            ],
          )
        }),
      ),
      ...(files.length === 0
        ? []
        : [
            h.p([], [`${files.length} ${files.length === 1 ? "file" : "files"}, ${formatSize(snapshot?.totalBytes ?? 0)} in total`]),
            h.p([h.Class("rename-note")], ["Renaming changes only the name a file is saved under in this browser. The sender's copies keep their names."]),
          ]),
      ...(snapshot?.phase === "Reviewing"
        ? [
            ...(snapshot.mobileWarning
              ? [
                  h.p(
                    [h.Class("mobile-data-warning"), h.Role("note")],
                    [`You seem to be on mobile data or in Data Saver mode. Accepting downloads ${formatSize(snapshot.totalBytes)}.`],
                  ),
                ]
              : []),
            ...(snapshot.spaceShortfall === undefined
              ? []
              : [
                  h.p(
                    [h.Class("space-warning"), h.Role("alert")],
                    [
                      `This browser can store about ${formatSize(snapshot.spaceShortfall)} for this site, but the files need ${formatSize(snapshot.totalBytes)}. Free up space, or open the link in a normal window: private windows have a small storage limit.`,
                    ],
                  ),
                ]),
            h.div(
              [h.Class("actions")],
              [
                button(
                  snapshot.mobileWarning ? `Accept and download ${formatSize(snapshot.totalBytes)} on mobile data` : "Accept",
                  Message.RequestedAccept(),
                  snapshot.spaceChecking || snapshot.spaceShortfall !== undefined,
                ),
                button("Decline", Message.RequestedDecline()),
              ],
            ),
          ]
        : []),
      ...(snapshot === undefined || (snapshot.phase !== "Receiving" && snapshot.phase !== "Committing")
        ? []
        : [
            Progress.view(
              {
                id: "receive-progress",
                value: snapshot.progress.done,
                max: Math.max(1, snapshot.progress.total),
                valueText: `Received ${snapshot.progress.done} of ${snapshot.progress.total} pieces`,
                toView: (attributes) =>
                  h.div(
                    [h.Class("progress")],
                    [
                      h.span(attributes.label, ["Receiving files"]),
                      h.div(attributes.progress, [h.div(attributes.track, [h.div(attributes.indicator)])]),
                      h.p(
                        [h.Class("progress-text")],
                        [
                          `Received ${snapshot.progress.total === 0 ? 0 : Math.round((snapshot.progress.done / snapshot.progress.total) * 100)}% of ${formatSize(snapshot.totalBytes)}`,
                        ],
                      ),
                    ],
                  ),
              },
              h,
            ),
          ]),
      ...(snapshot?.phase !== "Completed" || snapshot.filesRemoved
        ? []
        : [
            ...(files.length > 1 ? [button("Save all files", Message.RequestedSaveAll())] : []),
            h.div(
              [h.Class("remove-files")],
              [
                button("Remove from this browser", Message.RequestedRemoveAll()),
                h.p([h.Class("remove-files-note")], ["Received files stay in this browser only until you leave the page."]),
              ],
            ),
          ]),
      h.submodel({ slotId: "recipient-preview", model: model.preview, view: Preview.view, toParentMessage: liftPreview }),
    ],
  )
})
