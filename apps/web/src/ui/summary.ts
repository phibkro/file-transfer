import { Button } from "@foldkit/ui"
import { Effect, Option, Schema } from "effect"
import type { Update } from "foldkit"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineView } from "foldkit/submodel"
import { transferSummary } from "../report.ts"
import { directText, edgeLocation, megabytesPerSecond, pathText, reportText } from "../summary.ts"
import { formatSize } from "../view.ts"

const Summary = Schema.Struct({
  bytes: Schema.Finite,
  seconds: Schema.Finite,
  reconnects: Schema.Finite,
  direct: Schema.Boolean,
  secondsToDirect: Schema.UndefinedOr(Schema.Finite),
  directDrops: Schema.Finite,
})

export const Model = Schema.Struct({
  summary: Schema.Option(Summary),
  edge: Schema.String,
  text: Schema.String,
  copied: Schema.Boolean,
  status: Schema.String,
})

export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  Loaded: { summary: Summary, edge: Schema.String, text: Schema.String },
  ClickedCopy: {},
  Copied: {},
  Failed: {},
})

export type Message = typeof Message.Type

const Load = Command.define("LoadTransferSummary", {
  args: { role: Schema.Literals(["sender", "recipient"]) },
  messages: [Message.Loaded],
  execute: ({ role }) =>
    Effect.promise(async () => await edgeLocation()).pipe(
      Effect.map((location) => {
        const summary = transferSummary()
        const place = location ?? "unknown"

        return Message.Loaded({ summary, edge: place, text: reportText(role, summary, place) })
      }),
    ),
})

const Copy = Command.define("CopyTransferReport", {
  args: { text: Schema.String },
  messages: [Message.Copied, Message.Failed],
  execute: ({ text }) =>
    Effect.tryPromise({
      try: async () => {
        await navigator.clipboard.writeText(text)
      },
      catch: () => undefined,
    }).pipe(
      Effect.map(() => Message.Copied()),
      Effect.orElseSucceed(() => Message.Failed()),
    ),
})

export const init = (): Update.Return<Model, Message> => ({ model: { summary: Option.none(), edge: "unknown", text: "", copied: false, status: "" } })
export const boot = (role: "sender" | "recipient"): Update.Return<Model, Message> => ({ ...init(), commands: [Load({ role })] })

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match(message, {
    Loaded: ({ summary, edge, text }) => ({ model: { ...model, summary: Option.some(summary), edge, text } }),
    ClickedCopy: () => ({ model, commands: [Copy({ text: model.text })] }),
    Copied: () => ({ model: { ...model, copied: true, status: "" } }),
    Failed: () => ({ model: { ...model, status: "Could not copy report." } }),
  })

export const view = defineView<Model, Message>((model, h) => {
  if (Option.isNone(model.summary)) {
    return null
  }

  const summary = model.summary.value

  const rows = [
    ["Size", formatSize(summary.bytes)],
    ["Time", `${summary.seconds.toFixed(1)} s`],
    ["Speed", megabytesPerSecond(summary)],
    ["Reconnects", String(summary.reconnects)],
    ["Path", pathText(summary)],
    ["Direct path", directText(summary)],
    ["Cloudflare location", model.edge],
  ]

  return h.section(
    [h.Class("summary"), h.AriaLabel("Transfer summary")],
    [
      h.dl(
        [],
        rows.flatMap(([term, value]) => [h.dt([], [term ?? ""]), h.dd([], [value ?? ""])]),
      ),
      Button.view({ onClick: Message.ClickedCopy(), toView: (a) => h.button(a.button, [model.copied ? "Copied" : "Copy report"]) }, h),
      h.p([h.Role("status")], [model.status]),
    ],
  )
})
