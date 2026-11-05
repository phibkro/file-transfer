import { decodeLinkSecret } from "@file-transfer/parcel"
import { Button, Input } from "@foldkit/ui"
import { Effect, Option, Redacted, Schema } from "effect"
import type { Update } from "foldkit"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { load } from "foldkit/navigation"
import { defineView } from "foldkit/submodel"
import { privateValue } from "../privateValue.ts"
import { icon } from "./icon.ts"

const PrivateLink = privateValue<string>()

export const Model = Schema.Struct({ link: PrivateLink, problem: Schema.Option(Schema.String) })

export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  Changed: { link: PrivateLink },
  Submitted: {},
  Navigated: {},
})

export type Message = typeof Message.Type

export interface Context {
  readonly canNavigate: boolean
  readonly origin: string
}

const NavigateToRecipient = Command.define("NavigateToRecipient", {
  args: { link: PrivateLink },
  messages: [Message.Navigated],
  execute: ({ link }) => load(Redacted.value(link)).pipe(Effect.as(Message.Navigated())),
})

export const init = (): Model => ({ link: Redacted.make(""), problem: Option.none() })
export const boot = (): Update.Return<Model, Message> => ({ model: init() })

const validLink = (value: string, origin: string): boolean => {
  try {
    const url = new URL(value)

    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.origin !== origin ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      !/^\/r\/[A-Za-z0-9_-]{22}\/?$/u.test(url.pathname) ||
      url.hash === ""
    ) {
      return false
    }

    decodeLinkSecret(url.hash)

    return true
  } catch {
    return false
  }
}

export const update = (model: Model, message: Message, context: Context): Update.Return<Model, Message> =>
  Message.match(message, {
    Changed: ({ link }) => ({ model: { ...model, link, problem: Option.none() } }),
    Submitted: () => {
      const link = Redacted.value(model.link).trim()

      if (!validLink(link, context.origin)) {
        return { model: { ...model, problem: Option.some("Enter a valid recipient link, including its key.") } }
      }

      if (!context.canNavigate) {
        return { model: { ...model, problem: Option.some("Finish or cancel the current transfer before opening a link.") } }
      }

      return { model: { ...model, problem: Option.none() }, commands: [NavigateToRecipient({ link: Redacted.make(link) })] }
    },
    Navigated: () => ({ model }),
  })

export const view = defineView<Model, Message, Context>((model, _context, h) =>
  h.form(
    [h.Class("receive-form drop-zone"), h.OnSubmit(Message.Submitted())],
    [
      h.span([h.Class("upload-icon")], [icon(h, "receive")]),
      h.h3([], ["Open a transfer"]),
      h.p([], ["Paste a transfer link from this instance."]),
      h.div(
        [h.Class("flex w-full max-w-md items-center gap-2")],
        [
          Input.view(
            {
              id: "receive-link",
              value: Redacted.value(model.link),
              isInvalid: Option.isSome(model.problem),
              onInput: (link) => Message.Changed({ link: Redacted.make(link) }),
              toView: (attributes) =>
                h.div(
                  [h.Class("min-w-0 flex-1")],
                  [
                    h.label([...attributes.label, h.Class("visually-hidden")], ["Transfer link"]),
                    h.input([...attributes.input, h.Class("w-full"), h.Spellcheck(false), h.Placeholder("Paste a transfer link")]),
                  ],
                ),
            },
            h,
          ),
          Button.view(
            { type: "submit", toView: (attributes) => h.button([...attributes.button, h.Class("button primary")], ["Open link", icon(h, "arrow")]) },
            h,
          ),
        ],
      ),
      Option.isSome(model.problem) ? h.p([h.Class("text-destructive"), h.Role("alert")], [model.problem.value]) : null,
    ],
  ),
)
