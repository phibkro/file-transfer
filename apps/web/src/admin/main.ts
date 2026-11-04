import { Button, Fieldset, Input, Meter } from "@foldkit/ui"
import { Clock, Effect, Option, Redacted, Schema } from "effect"
import type { Update } from "foldkit"
import { Command, Mount } from "foldkit"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineView } from "foldkit/submodel"
import { privateValue } from "../privateValue.ts"
import { formatSize } from "../view.ts"
import { ChartMount } from "./chart.ts"
import { fetchCounters, fetchInstance, kinds, lastHours, readStoredToken, storeToken } from "./data.ts"
import type { Counters, HourRow, Instance } from "./data.ts"

const PrivateToken = privateValue<string>()
const PrivateInstance = privateValue<Instance | undefined>()
const PrivateCounts = privateValue<Extract<Counters, { counters: true }>>()
const PrivateRows = privateValue<readonly HourRow[]>()
const StorageWrite = Schema.Struct({ token: Schema.Option(PrivateToken), sequence: Schema.Int })

export const Model = Schema.Struct({
  token: PrivateToken,
  instance: Schema.Option(PrivateInstance),
  counts: Schema.Option(PrivateCounts),
  rows: Schema.Option(PrivateRows),
  status: Schema.String,
  request: Schema.Int,
  storageSequence: Schema.Int,
  storageActive: Schema.Option(Schema.Int),
  storagePending: Schema.Option(StorageWrite),
})

export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ChangedToken: { token: PrivateToken },
  RequestedCounts: {},
  RequestedForget: {},
  ReceivedInitial: { token: PrivateToken, instance: PrivateInstance },
  ReceivedCounts: { request: Schema.Int, status: Schema.Int, result: privateValue<Counters | undefined>(), rows: PrivateRows },
  FailedCounts: { request: Schema.Int },
  CompletedStorage: { sequence: Schema.Int },
  CompletedChart: { success: Schema.Boolean },
})

export type Message = typeof Message.Type

const ReadOperatorSettings = Command.define("ReadOperatorSettings", {
  messages: [Message.ReceivedInitial],
  execute: Effect.gen(function* () {
    const token = yield* readStoredToken

    const instance = yield* fetchInstance.pipe(
      Effect.map((response) => response.body),
      Effect.orElseSucceed(() => undefined),
    )

    return Message.ReceivedInitial({ token, instance: Redacted.make(instance) })
  }),
})

const ReadOperatorCounts = Command.define("ReadOperatorCounts", {
  args: { token: PrivateToken, request: Schema.Int },
  messages: [Message.ReceivedCounts, Message.FailedCounts],
  execute: ({ token, request }) =>
    fetchCounters(token).pipe(
      Effect.flatMap((response) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) =>
            Message.ReceivedCounts({
              request,
              status: response.status,
              result: Redacted.make(response.body),
              rows: Redacted.make(response.body?.counters === true ? lastHours(response.body.hours, now) : []),
            }),
          ),
        ),
      ),
      Effect.orElseSucceed(() => Message.FailedCounts({ request })),
    ),
})

const RememberOperatorToken = Command.define("RememberOperatorToken", {
  args: StorageWrite.fields,
  messages: [Message.CompletedStorage],
  execute: ({ token, sequence }) => storeToken(Option.getOrUndefined(token)).pipe(Effect.as(Message.CompletedStorage({ sequence }))),
})

export const init = (): Update.Return<Model, Message> => ({
  model: {
    token: Redacted.make(""),
    instance: Option.none(),
    counts: Option.none(),
    rows: Option.none(),
    status: "",
    request: 0,
    storageSequence: 0,
    storageActive: Option.none(),
    storagePending: Option.none(),
  },
})

export const boot = (): Update.Return<Model, Message> => ({ ...init(), commands: [ReadOperatorSettings()] })

const writeToken = (model: Model, token: Option.Option<Redacted.Redacted>): Update.Return<Model, Message> => {
  const write = { token, sequence: model.storageSequence + 1 }
  const next = { ...model, storageSequence: write.sequence }

  return Option.isSome(model.storageActive)
    ? { model: { ...next, storagePending: Option.some(write) } }
    : { model: { ...next, storageActive: Option.some(write.sequence) }, commands: [RememberOperatorToken(write)] }
}

const requestCounts = (model: Model): Update.Return<Model, Message> => {
  const token = Redacted.make(Redacted.value(model.token).trim())
  const request = model.request + 1

  if (Redacted.value(token) === "") {
    return {
      model: {
        ...model,
        token,
        request,
        counts: Option.none(),
        rows: Option.none(),
        status: "Enter the admin token you set with `wrangler secret put ADMIN_TOKEN`.",
      },
    }
  }

  return {
    model: { ...model, token, request, counts: Option.none(), rows: Option.none(), status: "Reading the counts." },
    commands: [ReadOperatorCounts({ token, request })],
  }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match(message, {
    ChangedToken: ({ token }) => ({ model: { ...model, token, request: model.request + 1, counts: Option.none(), rows: Option.none(), status: "" } }),
    RequestedCounts: () => requestCounts(model),
    RequestedForget: () =>
      writeToken(
        { ...model, token: Redacted.make(""), request: model.request + 1, counts: Option.none(), rows: Option.none(), status: "The token was forgotten." },
        Option.none(),
      ),
    ReceivedInitial: ({ token, instance }) => {
      const next = { ...model, instance: Option.some(instance) }

      if (model.request !== 0 || Redacted.value(model.token) !== "") {
        return { model: next }
      }

      return Redacted.value(token) === "" ? { model: next } : requestCounts({ ...next, token })
    },
    ReceivedCounts: ({ request, status, result, rows }) => {
      if (request !== model.request) {
        return { model }
      }

      if (status === 404) {
        return {
          model: { ...model, status: "This instance has no admin token, so its counts cannot be read here. Set one with `wrangler secret put ADMIN_TOKEN`." },
        }
      }

      if (status === 401) {
        return writeToken({ ...model, status: "That token is not this instance's admin token." }, Option.none())
      }

      const counts = Redacted.value(result)

      if (counts === undefined) {
        return { model: { ...model, status: "The counts could not be read." } }
      }

      if (counts.counters) {
        return writeToken({ ...model, counts: Option.some(Redacted.make(counts)), rows: Option.some(rows), status: "" }, Option.some(model.token))
      }

      return writeToken(
        { ...model, status: "Counting is off on this instance. Set COUNTERS to on to start counting; nothing was counted before." },
        Option.some(model.token),
      )
    },
    FailedCounts: ({ request }) => (request === model.request ? { model: { ...model, status: "The counts could not be read." } } : { model }),
    CompletedStorage: ({ sequence }) => {
      if (Option.isNone(model.storageActive) || model.storageActive.value !== sequence) {
        return { model }
      }

      if (Option.isNone(model.storagePending)) {
        return { model: { ...model, storageActive: Option.none() } }
      }

      const write = model.storagePending.value

      return { model: { ...model, storageActive: Option.some(write.sequence), storagePending: Option.none() }, commands: [RememberOperatorToken(write)] }
    },
    CompletedChart: ({ success }) => ({ model: success ? model : { ...model, status: "The 48-hour chart could not be displayed." } }),
  })

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const facts = (h: HtmlBuilder<Message>, rows: readonly (readonly [string, string])[]) =>
  h.dl(
    [h.Class("admin-facts")],
    rows.flatMap(([term, value]) => [h.dt([], [term]), h.dd([], [value])]),
  )

export const view = defineView<Model, Message>((model, h) => {
  const instance = Option.isSome(model.instance) ? Redacted.value(model.instance.value) : undefined
  const counts = Option.isSome(model.counts) ? Redacted.value(model.counts.value) : undefined
  const rows = Option.isSome(model.rows) ? Redacted.value(model.rows.value) : []
  const completed = counts?.total.byKind["transfer-completed"] ?? 0
  const failed = counts?.total.byKind["transfer-failed"] ?? 0
  const ended = completed + failed
  const valid = Number.isSafeInteger(ended) && ended > 0 && completed >= 0 && completed <= ended
  let completion = "unavailable (invalid counts)"

  if (ended === 0) {
    completion = "no transfers have ended yet"
  } else if (valid) {
    completion = `${Math.round((completed / ended) * 1000) / 10}%`
  }

  const relayedToday = rows.slice(-24).reduce((sum, row) => sum + (row.snapshot?.relayedMegabytes ?? 0), 0)

  return h.main(
    [h.Class("content admin"), h.Id("admin")],
    [
      h.h1([], ["Operator"]),
      h.p([h.Class("lead")], ["This instance's settings, and its counts when counting is on. Nothing here identifies a room, a person or a file."]),
      ...(Option.isSome(model.instance) && instance === undefined
        ? [h.p([h.Role("alert")], ["This instance does not describe its settings (an older version)."])]
        : []),
      ...(instance === undefined
        ? []
        : [
            h.section(
              [h.AriaLabelledBy("settings-heading")],
              [
                h.h2([h.Id("settings-heading")], ["Settings"]),
                facts(h, [
                  ["Counting", instance.counters ? "On" : "Off (set COUNTERS to on to count)"],
                  ["Rooms per address per hour", String(instance.limits.roomsPerAddressPerHour)],
                  ["Relayed per transfer, at most", formatSize(instance.limits.relayedBytesPerRoom)],
                  [
                    "Relayed per day by everyone, at most",
                    instance.limits.relayedBytesPerDay === undefined || instance.limits.relayedBytesPerDay === null
                      ? "No daily budget"
                      : formatSize(instance.limits.relayedBytesPerDay),
                  ],
                ]),
              ],
            ),
          ]),
      h.form(
        [h.Class("admin-token"), h.OnSubmit(Message.RequestedCounts())],
        [
          Fieldset.view(
            {
              id: "admin-access",
              toView: (fieldset) =>
                h.fieldset(fieldset.fieldset, [
                  h.legend(fieldset.legend, ["Operator access"]),
                  Input.view(
                    {
                      id: "admin-token",
                      type: "password",
                      value: Redacted.value(model.token),
                      onInput: (token) => Message.ChangedToken({ token: Redacted.make(token) }),
                      toView: (input) =>
                        h.div([], [h.label(input.label, ["Admin token"]), h.input([...input.input, h.Autocomplete("off"), h.Spellcheck(false)])]),
                    },
                    h,
                  ),
                  Button.view({ type: "submit", toView: (button) => h.button([...button.button, h.Class("primary")], ["Show counts"]) }, h),
                  Button.view({ onClick: Message.RequestedForget(), toView: (button) => h.button(button.button, ["Forget token"]) }, h),
                ]),
            },
            h,
          ),
        ],
      ),
      h.p([h.Class("admin-status"), h.Role("status")], [model.status]),
      ...(counts === undefined
        ? []
        : [
            h.section(
              [h.AriaLabelledBy("counts-heading")],
              [
                h.h2([h.Id("counts-heading")], ["Counts"]),
                facts(h, [
                  ["Completed, of transfers that ended", completion],
                  ["Relayed in the last 24 hours", formatSize(relayedToday * 1_000_000)],
                  ["Relayed since counting began", formatSize(counts.total.relayedMegabytes * 1_000_000)],
                ]),
                ...(valid
                  ? [
                      Meter.view(
                        {
                          id: "completion",
                          value: completed,
                          min: 0,
                          max: ended,
                          ariaLabel: "Completed, of transfers that ended",
                          valueText: completion,
                          toView: (meter) => h.div(meter.meter, [h.span(meter.fill)]),
                        },
                        h,
                      ),
                    ]
                  : []),
                h.h3([], ["Last 48 hours"]),
                h.keyed("div")(model.request, [
                  h.Class("admin-chart"),
                  h.Role("img"),
                  h.AriaLabel("Rooms created, completed and failed transfers per hour, last 48 hours"),
                  h.OnMount(Mount.mapMessage(ChartMount({ rows: Redacted.make(rows) }), ({ success }) => Message.CompletedChart({ success }))),
                ]),
                h.h3([], ["Totals since counting began"]),
                h.div(
                  [h.Class("table-wrap")],
                  [
                    h.table(
                      [],
                      [
                        h.thead([], [h.tr([], [h.th([h.Scope("col")], ["What"]), h.th([h.Scope("col")], ["Count"])])]),
                        h.tbody(
                          [],
                          kinds.map((kind) => h.tr([], [h.td([], [sentenceCase(counts.kinds[kind] ?? kind)]), h.td([], [String(counts.total.byKind[kind])])])),
                        ),
                      ],
                    ),
                  ],
                ),
                h.p(
                  [h.Class("admin-note")],
                  ["Prometheus and Grafana can read the totals at /api/admin/metrics with the same token (Authorization: Bearer <token>)."],
                ),
              ],
            ),
          ]),
    ],
  )
})
