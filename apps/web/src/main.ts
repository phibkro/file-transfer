import { Effect, Match, Option, Queue, Schema, Stream } from "effect"
import type { Runtime } from "foldkit"
import { Command, ManagedResource, Subscription, Update } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { pushUrl } from "foldkit/navigation"
import { MainRoute, libraryRouter, quickShareRouter } from "./routes.ts"
import { defineTaggedUnion } from "foldkit/schema"
import * as Library from "./library/main.ts"
import * as Recipient from "./recipient/main.ts"
import * as Sender from "./sender/main.ts"
import * as Settings from "./ui/settings.ts"
import * as Summary from "./ui/summary.ts"
import { siteFooter, siteHeader } from "./site/layout.ts"
import { installLeaveGuard } from "./leaveGuard.ts"
import { currentStatus, installTestHook, onReport } from "./report.ts"
import { privateValue } from "./privateValue.ts"

export const Flags = Schema.Struct({ route: MainRoute, fragment: privateValue<string>() })

const Page = defineTaggedUnion({
  Sender: { sender: Sender.Model },
  Recipient: { recipient: Recipient.Model },
  Library: { library: Library.Model },
})

type Page = typeof Page.Type

export const Model = Schema.Struct({
  page: Page,
  settings: Settings.Model,
  summary: Summary.Model,
  isComplete: Schema.Boolean,
})

export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  GotSenderMessage: { message: Sender.Message },
  GotRecipientMessage: { message: Recipient.Message },
  GotLibraryMessage: { message: Library.Message },
  GotSettingsMessage: { message: Settings.Message },
  GotSummaryMessage: { message: Summary.Message },
  CompletedTransfer: {},
  CompletedShowQuickShare: {},
})

export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message, Recipient.Services>

export const init: Runtime.ApplicationInit<Model, Message, typeof Flags.Type, never, Recipient.Services> = ({ route, fragment }) => {
  const pageBoot = Match.value(route).pipe(
    Match.withReturnType<Update.Return<Page, Message, Recipient.Services>>(),
    Match.tagsExhaustive({
      QuickShare: () =>
        Update.foldChildInit(Sender.boot({ autoSeal: false }), {
          toParentModel: (sender) => Page.Sender({ sender }),
          toParentMessage: (message) => Message.GotSenderMessage({ message }),
        }),
      Recipient: ({ roomIdentifier }) =>
        Update.foldChildInit(Recipient.boot(roomIdentifier, fragment), {
          toParentModel: (recipient) => Page.Recipient({ recipient }),
          toParentMessage: (message) => Message.GotRecipientMessage({ message }),
        }),
      Library: () =>
        Update.foldChildInit(Library.boot(), {
          toParentModel: (library) => Page.Library({ library }),
          toParentMessage: (message) => Message.GotLibraryMessage({ message }),
        }),
    }),
  )

  const settingsBoot = Settings.boot()
  const summaryInit = Summary.init()

  return {
    model: { page: pageBoot.model, settings: settingsBoot.model, summary: summaryInit.model, isComplete: false },
    commands: [...(pageBoot.commands ?? []), ...Command.mapMessages(settingsBoot.commands, (message) => Message.GotSettingsMessage({ message }))],
  }
}

const readSender = (model: Model) =>
  Page.match(model.page, {
    Sender: ({ sender }) => Option.some(sender),
    Recipient: () => Option.none(),
    Library: () => Option.none(),
  })

const readRecipient = (model: Model) =>
  Page.match(model.page, {
    Sender: () => Option.none(),
    Recipient: ({ recipient }) => Option.some(recipient),
    Library: () => Option.none(),
  })

const readLibrary = (model: Model) =>
  Page.match(model.page, {
    Sender: () => Option.none(),
    Recipient: () => Option.none(),
    Library: ({ library }) => Option.some(library),
  })

const foldSender = Update.foldChild({
  update: Sender.update,
  read: readSender,
  write: (model, sender) => ({ ...model, page: Page.Sender({ sender }) }),
  toParentMessage: (message) => Message.GotSenderMessage({ message }),
})

const foldRecipient = Update.foldChild({
  update: Recipient.update,
  read: readRecipient,
  write: (model, recipient) => ({ ...model, page: Page.Recipient({ recipient }) }),
  toParentMessage: (message) => Message.GotRecipientMessage({ message }),
})

const ShowQuickShare = Command.define("ShowQuickShare", {
  messages: [Message.CompletedShowQuickShare],
  execute: pushUrl(quickShareRouter()).pipe(Effect.as(Message.CompletedShowQuickShare())),
})

const foldLibraryOutMessage = Library.OutMessage.match<Update.Step<Model, Message>>({
  RequestedQuickShare:
    ({ files }) =>
    (model) => {
      const senderBoot = Update.foldChildInit(Sender.boot({ files, autoSeal: true }), {
        toParentModel: (sender) => ({ ...model, page: Page.Sender({ sender }), summary: Summary.init().model, isComplete: false }),
        toParentMessage: (message) => Message.GotSenderMessage({ message }),
      })

      return { model: senderBoot.model, commands: [...(senderBoot.commands ?? []), ShowQuickShare()] }
    },
})

const foldLibrary = Update.foldChild({
  update: Library.update,
  read: readLibrary,
  write: (model, library) => ({ ...model, page: Page.Library({ library }) }),
  toParentMessage: (message) => Message.GotLibraryMessage({ message }),
  foldOutMessage: foldLibraryOutMessage,
})

const foldSettings = Update.foldChild({
  update: Settings.update,
  read: (model: Model) => Option.some(model.settings),
  write: (model, settings) => ({ ...model, settings }),
  toParentMessage: (message) => Message.GotSettingsMessage({ message }),
})

const foldSummary = Update.foldChild({
  update: Summary.update,
  read: (model: Model) => Option.some(model.summary),
  write: (model, summary) => ({ ...model, summary }),
  toParentMessage: (message) => Message.GotSummaryMessage({ message }),
})

export const update = (model: Model, incoming: Message) =>
  Message.match<UpdateReturn>(incoming, {
    GotSenderMessage: ({ message }) => foldSender(model, message),
    GotRecipientMessage: ({ message }) => foldRecipient(model, message),
    GotLibraryMessage: ({ message }) => foldLibrary(model, message),
    GotSettingsMessage: ({ message }) => foldSettings(model, message),
    GotSummaryMessage: ({ message }) => foldSummary(model, message),
    CompletedShowQuickShare: () => ({ model }),
    CompletedTransfer: () => {
      if (model.isComplete || model.page._tag === "Library") {
        return { model }
      }

      return Update.foldChildInit(Summary.boot(model.page._tag === "Sender" ? "sender" : "recipient"), {
        toParentModel: (summary) => ({ ...model, summary, isComplete: true }),
        toParentMessage: (message) => Message.GotSummaryMessage({ message }),
      })
    },
  })

const observeTransfer = Stream.callback<Message>((queue) => {
  const reportChanged = () => {
    if (currentStatus() === "complete") {
      Queue.offerUnsafe(queue, Message.CompletedTransfer())
    }
  }

  return Effect.acquireRelease(
    Effect.sync(() => {
      const removeHook = installTestHook()
      const removeLeaveGuard = installLeaveGuard()
      const removeReportListener = onReport(reportChanged)
      reportChanged()

      return () => {
        removeReportListener()
        removeLeaveGuard()
        removeHook()
      }
    }),
    (dispose) => Effect.sync(dispose),
  ).pipe(Effect.flatMap(() => Effect.never))
})

const globalSubscriptions = Subscription.make<Model, Message>()(() => ({
  transferReport: Subscription.persistentEntry(observeTransfer),
}))

export const subscriptions = Subscription.aggregate(
  globalSubscriptions,
  Subscription.lift(Sender.subscriptions)({ read: readSender, toParentMessage: (message) => Message.GotSenderMessage({ message }) }),
  Subscription.lift(Recipient.subscriptions)({ read: readRecipient, toParentMessage: (message) => Message.GotRecipientMessage({ message }) }),
)

export const managedResources = ManagedResource.lift(Recipient.managedResources)({
  read: readRecipient,
  toParentMessage: (message) => Message.GotRecipientMessage({ message }),
})

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "File transfer",
  body: h.div(
    [h.Class("application")],
    [
      siteHeader(
        h,
        Page.match<string | undefined>(model.page, {
          Sender: () => quickShareRouter(),
          Recipient: () => undefined,
          Library: () => libraryRouter(),
        }),
      ),
      h.main(
        [],
        [
          Page.match(model.page, {
            Sender: ({ sender }) =>
              h.submodel({ slotId: "sender", model: sender, view: Sender.view, toParentMessage: (message) => Message.GotSenderMessage({ message }) }),
            Recipient: ({ recipient }) =>
              h.submodel({
                slotId: "recipient",
                model: recipient,
                view: Recipient.view,
                toParentMessage: (message) => Message.GotRecipientMessage({ message }),
              }),
            Library: ({ library }) =>
              h.submodel({ slotId: "library", model: library, view: Library.view, toParentMessage: (message) => Message.GotLibraryMessage({ message }) }),
          }),
          h.submodel({ slotId: "summary", model: model.summary, view: Summary.view, toParentMessage: (message) => Message.GotSummaryMessage({ message }) }),
          h.submodel({ slotId: "settings", model: model.settings, view: Settings.view, toParentMessage: (message) => Message.GotSettingsMessage({ message }) }),
        ],
      ),
      siteFooter(h),
    ],
  ),
})
