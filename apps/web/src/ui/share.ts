import * as BrowserClipboard from "@effect/platform-browser/Clipboard"
import { Button, Disclosure, Input } from "@foldkit/ui"
import { Effect, Option, Redacted, Schema } from "effect"
import type { Update } from "foldkit"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineView } from "foldkit/submodel"
import { privateValue } from "./privateValue.ts"
import { icon } from "./icon.ts"

interface Qr {
  readonly size: number
  readonly path: string
}

const PrivateLink = privateValue<string>()
const PrivateQr = privateValue<Qr>()

export const Model = Schema.Struct({
  link: Schema.Option(PrivateLink),
  revealed: Schema.Boolean,
  qrOpen: Schema.Boolean,
  qr: Schema.Option(PrivateQr),
  copied: Schema.Boolean,
  canShare: Schema.Boolean,
  status: Schema.String,
})

export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ToggledLink: { open: Schema.Boolean },
  ToggledQr: { open: Schema.Boolean },
  ClickedCopy: {},
  ClickedShare: {},
  Copied: {},
  Shared: {},
  Failed: {},
  CheckedShare: { link: PrivateLink, available: Schema.Boolean },
  GeneratedQr: { qr: PrivateQr, link: PrivateLink },
})

export type Message = typeof Message.Type

const CheckNativeShare = Command.define("CheckNativeShare", {
  args: { link: PrivateLink },
  messages: [Message.CheckedShare],
  execute: ({ link }) =>
    Effect.sync(() => Message.CheckedShare({ link, available: "share" in navigator && (navigator.canShare?.({ url: Redacted.value(link) }) ?? true) })),
})

const CopyShareLink = Command.define("CopyShareLink", {
  args: { link: PrivateLink },
  messages: [Message.Copied, Message.Failed],
  execute: ({ link }) =>
    Effect.flatMap(BrowserClipboard.Clipboard, (clipboard) => clipboard.writeString(Redacted.value(link))).pipe(
      Effect.provide(BrowserClipboard.layer),
      Effect.map(() => Message.Copied()),
      Effect.orElseSucceed(() => Message.Failed()),
    ),
})

const ShareLink = Command.define("ShareLink", {
  args: { link: PrivateLink },
  messages: [Message.Shared, Message.Failed],
  execute: ({ link }) =>
    Effect.tryPromise({
      try: async () => {
        await navigator.share({ title: "Files for you", text: "I sent you some files.", url: Redacted.value(link) })
      },
      catch: () => undefined,
    }).pipe(
      Effect.map(() => Message.Shared()),
      Effect.orElseSucceed(() => Message.Failed()),
    ),
})

const GenerateShareQr = Command.define("GenerateShareQr", {
  args: { link: PrivateLink },
  messages: [Message.GeneratedQr, Message.Failed],
  execute: ({ link }) =>
    Effect.tryPromise({
      try: async () => {
        // Lazy loading keeps the QR encoder off pages where the person never requests a QR code.
        const { encode } = await import("uqr")
        const { data, size } = encode(Redacted.value(link), { ecc: "M", border: 4 })

        return { size, path: data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join("") }
      },
      catch: () => undefined,
    }).pipe(
      Effect.map((qr) => Message.GeneratedQr({ link, qr: Redacted.make(qr) })),
      Effect.orElseSucceed(() => Message.Failed()),
    ),
})

export const init = (): Update.Return<Model, Message> => ({
  model: { link: Option.none(), revealed: false, qrOpen: false, qr: Option.none(), copied: false, canShare: false, status: "" },
})

export const boot = (link: Redacted.Redacted): Update.Return<Model, Message> => ({
  model: { ...init().model, link: Option.some(link) },
  commands: [CheckNativeShare({ link })],
})

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match(message, {
    ToggledLink: ({ open }) => ({ model: { ...model, revealed: open } }),
    ToggledQr: ({ open }) => {
      const next = { ...model, qrOpen: open }

      return open && Option.isNone(model.qr) && Option.isSome(model.link)
        ? { model: next, commands: [GenerateShareQr({ link: model.link.value })] }
        : { model: next }
    },
    ClickedCopy: () => (Option.isSome(model.link) ? { model, commands: [CopyShareLink({ link: model.link.value })] } : { model }),
    ClickedShare: () => (Option.isSome(model.link) ? { model, commands: [ShareLink({ link: model.link.value })] } : { model }),
    Copied: () => ({ model: { ...model, copied: true, status: "" } }),
    Shared: () => ({ model }),
    CheckedShare: ({ link, available }) =>
      Option.isSome(model.link) && Redacted.value(model.link.value) === Redacted.value(link) ? { model: { ...model, canShare: available } } : { model },
    Failed: () => ({ model: { ...model, status: "Could not complete that action. Reveal the link to copy it manually." } }),
    GeneratedQr: ({ qr, link }) =>
      Option.isSome(model.link) && Redacted.value(model.link.value) === Redacted.value(link) ? { model: { ...model, qr: Option.some(qr) } } : { model },
  })

export const view = defineView<Model, Message>((model, h) => {
  if (Option.isNone(model.link)) {
    return null
  }

  const link = Redacted.value(model.link.value)
  const hash = link.indexOf("#")
  const masked = hash === -1 ? link : `${link.slice(0, hash + 1)}${"•".repeat(12)}`
  const qr = Option.isSome(model.qr) ? Redacted.value(model.qr.value) : undefined

  return h.div(
    [h.Class("share")],
    [
      Input.view(
        {
          id: "link",
          value: model.revealed ? link : masked,
          isReadOnly: true,
          toView: (attributes) => h.div([], [h.label(attributes.label, ["Share this link"]), h.input(attributes.input)]),
        },
        h,
      ),
      h.div(
        [h.Class("share-actions")],
        [
          Button.view(
            {
              onClick: Message.ClickedCopy(),
              toView: (a) => h.button([...a.button, h.Class("button primary")], [icon(h, "copy"), model.copied ? "Copied" : "Copy link"]),
            },
            h,
          ),
          model.canShare ? Button.view({ onClick: Message.ClickedShare(), toView: (a) => h.button([...a.button, h.Class("button")], ["Share"]) }, h) : null,
          Disclosure.view(
            {
              id: "share-link",
              isOpen: model.revealed,
              onToggle: (open) => Message.ToggledLink({ open }),
              toView: (a) => h.button([...a.button, h.Class("button")], [model.revealed ? "Hide link" : "Show link"]),
            },
            h,
          ),
          Disclosure.view(
            {
              id: "share-qr",
              isOpen: model.qrOpen,
              onToggle: (open) => Message.ToggledQr({ open }),
              toView: (a) =>
                h.div(
                  [],
                  [
                    h.button([...a.button, h.Class("button")], [model.qrOpen ? "Hide QR code" : "Show QR code"]),
                    ...(model.qrOpen && qr !== undefined
                      ? [
                          h.figure(
                            [...a.panel, h.Class("share-qr")],
                            [
                              h.svg(
                                [
                                  h.ViewBox(`0 0 ${qr.size} ${qr.size}`),
                                  h.Role("img"),
                                  h.AriaLabel("QR code of the share link"),
                                  h.Class("qr-code"),
                                  h.ShapeRendering("crispEdges"),
                                ],
                                [h.rect([h.Width(String(qr.size)), h.Height(String(qr.size)), h.Fill("#fff")]), h.path([h.D(qr.path), h.Fill("#000")])],
                              ),
                              h.figcaption([], ["Scan to open on a phone"]),
                            ],
                          ),
                        ]
                      : []),
                  ],
                ),
            },
            h,
          ),
        ],
      ),
      h.p([h.Class("share-warning")], ["Anyone with this link can open the files until the transfer ends."]),
      h.p([h.Role("status")], [model.status]),
    ],
  )
})
