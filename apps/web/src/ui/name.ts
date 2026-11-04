import { Button, Input } from "@foldkit/ui"
import { Option, Redacted, Schema } from "effect"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineView } from "foldkit/submodel"
import { privateValue } from "../privateValue.ts"
import { renameProblem } from "../selection.ts"

export const Model = Schema.Struct({ identifier: Schema.String, editing: Schema.Boolean, draft: privateValue<string>(), problem: Schema.Option(Schema.String) })

export type Model = typeof Model.Type

export const Message = defineMessageUnion({ Started: {}, Changed: { name: privateValue<string>() }, Saved: {}, Cancelled: {} })

export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ Renamed: { name: privateValue<string>() } })

export type OutMessage = typeof OutMessage.Type

export interface Context {
  readonly name: Redacted.Redacted
  readonly names: readonly string[]
  readonly index: number
  readonly canRename: boolean
}

export const init = (identifier: string): Model => ({ identifier, editing: false, draft: Redacted.make(""), problem: Option.none() })

export const boot = (identifier: string): Update.Return<Model, Message> => ({ model: init(identifier) })

export const update = (model: Model, message: Message, context: Context): Update.ReturnWithOutMessage<Model, Message, OutMessage> =>
  Message.match(message, {
    Started: () => (context.canRename ? { model: { ...model, editing: true, draft: context.name, problem: Option.none() } } : { model }),
    Changed: ({ name }) => ({ model: { ...model, draft: name, problem: Option.none() } }),
    Cancelled: () => ({ model: { ...model, editing: false, draft: Redacted.make(""), problem: Option.none() } }),
    Saved: () => {
      if (!context.canRename) {
        return { model: { ...model, editing: false, draft: Redacted.make("") } }
      }

      const candidate = Redacted.value(model.draft).trim().normalize("NFC")
      const current = Redacted.value(context.name)
      const problem = candidate === current ? undefined : renameProblem(context.names, context.index, candidate)

      if (problem !== undefined) {
        return { model: { ...model, problem: Option.some(problem) } }
      }

      const next = { ...model, editing: false, draft: Redacted.make(""), problem: Option.none<string>() }

      return candidate === current ? { model: next } : { model: next, outMessage: OutMessage.Renamed({ name: Redacted.make(candidate) }) }
    },
  })

export const view = defineView<Model, Message, Context>((model, context, h) => {
  const name = Redacted.value(context.name)

  if (!model.editing || !context.canRename) {
    return h.span(
      [h.Class("name-field")],
      [
        h.span([h.Class("name")], [name]),
        Button.view(
          {
            isDisabled: !context.canRename,
            onClick: Message.Started(),
            toView: (attributes) => h.button([...attributes.button, h.Class("rename"), h.AriaLabel(`Rename ${name}`)], ["Rename"]),
          },
          h,
        ),
      ],
    )
  }

  return h.form(
    [h.Class("rename-form"), h.OnSubmit(Message.Saved())],
    [
      Input.view(
        {
          id: model.identifier,
          value: Redacted.value(model.draft),
          isAutofocus: true,
          isInvalid: Option.isSome(model.problem),
          onInput: (value) => Message.Changed({ name: Redacted.make(value) }),
          toView: (attributes) =>
            h.input([
              ...attributes.input,
              h.Class("rename-input"),
              h.AriaLabel(`New name for ${name}`),
              h.Spellcheck(false),
              h.OnKeyDownPreventDefault((key) => (key === "Escape" ? Option.some(Message.Cancelled()) : Option.none())),
            ]),
        },
        h,
      ),
      h.button([h.Type("submit")], ["Save"]),
      Button.view({ onClick: Message.Cancelled(), toView: (attributes) => h.button(attributes.button, ["Cancel"]) }, h),
      Option.isSome(model.problem) ? h.p([h.Class("rename-problem"), h.Role("alert")], [`This name cannot be used: ${model.problem.value}.`]) : null,
    ],
  )
})
