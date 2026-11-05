import { Effect, Match, Option, Queue, Redacted, Schema, Stream } from "effect"
import type { Runtime } from "foldkit"
import { Command, ManagedResource, Subscription, Update } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { focus, scrollIntoViewAfterPaint, streamFromEventFilterMap } from "foldkit/dom"
import { MainRoute, parsePath, workspacePathForSection, workspaceSectionForRoute } from "./routes.ts"
import { defineTaggedUnion } from "foldkit/schema"
import * as Library from "../features/library/main.ts"
import * as Recipient from "../features/receive/main.ts"
import * as Sender from "../features/quick-share/main.ts"
import * as Settings from "../features/settings/main.ts"
import * as Summary from "../ui/summary.ts"
import { siteFooter, siteHeader, workspaceHero } from "../site/layout.ts"
import { installLeaveGuard } from "./leaveGuard.ts"
import { currentStatus, installTestHook, onReport } from "../capabilities/transfer/report.ts"
import { privateValue } from "../ui/privateValue.ts"
import { pagePath, workspaceAnchor } from "./address.ts"

export const Flags = Schema.Struct({
  route: MainRoute,
  fragment: privateValue<string>(),
  initialSection: Schema.Literals(["quick", "library"]),
  origin: Schema.String,
})

const Page = defineTaggedUnion({
  Workspace: { sender: Sender.Model, library: Library.Model },
  Recipient: { recipient: Recipient.Model },
})

type Page = typeof Page.Type

export const Model = Schema.Struct({
  page: Page,
  settings: Settings.Model,
  summary: Summary.Model,
  isComplete: Schema.Boolean,
  section: Schema.Literals(["quick", "library"]),
  handoffBlocked: Schema.Boolean,
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
  NavigatedWorkspace: { section: Schema.Literals(["quick", "library"]) },
})

export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message, Recipient.Services>

export const init: Runtime.ApplicationInit<Model, Message, typeof Flags.Type, never, Recipient.Services> = ({ route, fragment, initialSection, origin }) => {
  const workspaceBoot = (): Update.Return<Page, Message> => {
    const sender = Sender.boot({ autoSeal: false, origin })
    const library = Library.boot()

    return {
      model: Page.Workspace({ sender: sender.model, library: library.model }),
      commands: [
        ...Command.mapMessages(sender.commands, (message) => Message.GotSenderMessage({ message })),
        ...Command.mapMessages(library.commands, (message) => Message.GotLibraryMessage({ message })),
      ],
    }
  }

  const pageBoot = Match.value(route).pipe(
    Match.withReturnType<Update.Return<Page, Message, Recipient.Services>>(),
    Match.tagsExhaustive({
      QuickShare: workspaceBoot,
      Recipient: ({ roomIdentifier }) =>
        Update.foldChildInit(Recipient.boot(roomIdentifier, fragment), {
          toParentModel: (recipient) => Page.Recipient({ recipient }),
          toParentMessage: (message) => Message.GotRecipientMessage({ message }),
        }),
      Library: workspaceBoot,
    }),
  )

  const settingsBoot = Settings.boot()
  const summaryInit = Summary.init()

  return {
    model: {
      page: pageBoot.model,
      settings: settingsBoot.model,
      summary: summaryInit.model,
      isComplete: false,
      section: initialSection,
      handoffBlocked: false,
    },
    commands: [...(pageBoot.commands ?? []), ...Command.mapMessages(settingsBoot.commands, (message) => Message.GotSettingsMessage({ message }))],
  }
}

const readSender = (model: Model) =>
  Page.match(model.page, {
    Workspace: ({ sender }) => Option.some(sender),
    Recipient: () => Option.none(),
  })

const readRecipient = (model: Model) =>
  Page.match(model.page, {
    Workspace: () => Option.none(),
    Recipient: ({ recipient }) => Option.some(recipient),
  })

const readLibrary = (model: Model) =>
  Page.match(model.page, {
    Workspace: ({ library }) => Option.some(library),
    Recipient: () => Option.none(),
  })

const foldSender = Update.foldChild({
  update: Sender.update,
  read: readSender,
  write: (model, sender) => (model.page._tag === "Workspace" ? { ...model, page: Page.Workspace({ ...model.page, sender }) } : model),
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
  execute: scrollIntoViewAfterPaint("#quick", { block: "start" }).pipe(
    Effect.andThen(focus("#quick", { makeFocusable: true, preventScroll: true })),
    Effect.ignore,
    Effect.as(Message.CompletedShowQuickShare()),
  ),
})

const ShowLibrary = Command.define("ShowLibrary", {
  messages: [Message.CompletedShowQuickShare],
  execute: scrollIntoViewAfterPaint("#library", { block: "start" }).pipe(
    Effect.andThen(focus("#library", { makeFocusable: true, preventScroll: true })),
    Effect.ignore,
    Effect.as(Message.CompletedShowQuickShare()),
  ),
})

const foldLibraryOutMessage = Library.OutMessage.match<Update.Step<Model, Message>>({
  RequestedQuickShare:
    ({ files }) =>
    (model) => {
      if (model.page._tag !== "Workspace") {
        return { model }
      }

      const { sender, library } = model.page

      if (sender.active || (!sender.sealed && Redacted.value(sender.entries).length > 0)) {
        return { model: { ...model, handoffBlocked: true } }
      }

      const senderBoot = Update.foldChildInit(Sender.boot({ files, autoSeal: true, origin: sender.origin }), {
        toParentModel: (nextSender) => ({
          ...model,
          page: Page.Workspace({ sender: nextSender, library }),
          summary: Summary.init().model,
          isComplete: false,
          section: "quick" as const,
          handoffBlocked: false,
        }),
        toParentMessage: (message) => Message.GotSenderMessage({ message }),
      })

      return { model: senderBoot.model, commands: [...(senderBoot.commands ?? []), ShowQuickShare()] }
    },
})

const foldLibrary = Update.foldChild({
  update: Library.update,
  read: readLibrary,
  write: (model, library) => (model.page._tag === "Workspace" ? { ...model, page: Page.Workspace({ ...model.page, library }) } : model),
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
    GotLibraryMessage: ({ message }) => {
      const initialLoad = model.page._tag === "Workspace" && model.page.library.loadState === "loading"
      const next = foldLibrary(model, message)

      return initialLoad && next.model.section === "library" && next.model.page._tag === "Workspace" && next.model.page.library.loadState !== "loading"
        ? { ...next, commands: [...(next.commands ?? []), ShowLibrary()] }
        : next
    },
    GotSettingsMessage: ({ message }) => foldSettings(model, message),
    GotSummaryMessage: ({ message }) => foldSummary(model, message),
    CompletedShowQuickShare: () => ({ model }),
    NavigatedWorkspace: ({ section }) => ({ model: { ...model, section } }),
    CompletedTransfer: () => {
      if (model.isComplete) {
        return { model }
      }

      return Update.foldChildInit(Summary.boot(model.page._tag === "Workspace" ? "sender" : "recipient"), {
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

const globalSubscriptions = Subscription.make<Model, Message>()((entry) => ({
  transferReport: Subscription.persistentEntry(observeTransfer),
  workspaceNavigation: entry(
    { workspace: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ workspace: model.page._tag === "Workspace" }),
      dependenciesToStream: ({ workspace }) =>
        workspace
          ? streamFromEventFilterMap({
              target: () => window,
              type: "hashchange",
              filterMapEvent: () => Option.some({ path: pagePath(), anchor: workspaceAnchor() }),
            }).pipe(
              Stream.mapEffect(({ path, anchor }) =>
                parsePath(path).pipe(
                  Effect.map((matched) => {
                    const routeSection = Option.isSome(matched) ? workspaceSectionForRoute(matched.value._tag) : undefined

                    return routeSection === undefined ? Option.none() : Option.some(Message.NavigatedWorkspace({ section: anchor ?? routeSection }))
                  }),
                ),
              ),
              Stream.flatMap((message) => (Option.isSome(message) ? Stream.succeed(message.value) : Stream.empty)),
            )
          : Stream.empty,
    },
  ),
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

const workspacePath = (model: Model): string | undefined => {
  if (model.page._tag !== "Workspace") {
    return undefined
  }

  return workspacePathForSection(model.section)
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Pocketdrop",
  body: h.div(
    [h.Class("application")],
    [
      siteHeader(
        h,
        workspacePath(model),
        model.page._tag === "Workspace"
          ? { quick: Message.NavigatedWorkspace({ section: "quick" }), library: Message.NavigatedWorkspace({ section: "library" }) }
          : undefined,
      ),
      h.main(
        [h.Class("shell workspace")],
        [
          Page.match(model.page, {
            Workspace: ({ sender, library }) =>
              h.div(
                [],
                [
                  workspaceHero(h),
                  h.submodel({ slotId: "sender", model: sender, view: Sender.view, toParentMessage: (message) => Message.GotSenderMessage({ message }) }),
                  ...(model.handoffBlocked ? [h.p([h.Role("alert")], ["Finish or clear the current Quick Share before sharing from your library."])] : []),
                  h.submodel({
                    slotId: "library",
                    model: library,
                    view: Library.view,
                    viewInputs: { sharingDisabled: sender.active || (!sender.sealed && Redacted.value(sender.entries).length > 0) },
                    toParentMessage: (message) => Message.GotLibraryMessage({ message }),
                  }),
                ],
              ),
            Recipient: ({ recipient }) =>
              h.submodel({
                slotId: "recipient",
                model: recipient,
                view: Recipient.view,
                toParentMessage: (message) => Message.GotRecipientMessage({ message }),
              }),
          }),
          h.submodel({ slotId: "summary", model: model.summary, view: Summary.view, toParentMessage: (message) => Message.GotSummaryMessage({ message }) }),
          h.submodel({ slotId: "settings", model: model.settings, view: Settings.view, toParentMessage: (message) => Message.GotSettingsMessage({ message }) }),
        ],
      ),
      siteFooter(h, { support: model.page._tag === "Workspace" }),
    ],
  ),
})
