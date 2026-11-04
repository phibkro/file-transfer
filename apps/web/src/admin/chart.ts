import { Effect, Redacted, Schema } from "effect"
import { Mount } from "foldkit"
import "uplot/dist/uPlot.min.css"
import { privateValue } from "../privateValue.ts"
import type { HourRow } from "./data.ts"

export const ChartMessage = Schema.TaggedStruct("CompletedChartMount", { success: Schema.Boolean })

export type ChartMessage = typeof ChartMessage.Type

const color = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

/** The rendered element owns the uPlot instance until it is removed. */
export const ChartMount = Mount.define("AdminChart", {
  args: { rows: privateValue<readonly HourRow[]>() },
  messages: [ChartMessage],
  execute: ({ element, rows }) =>
    Effect.gen(function* () {
      const loaded = yield* Effect.tryPromise({
        try: async () => await import("uplot"),
        catch: () => false as const,
      }).pipe(Effect.result)

      if (loaded._tag === "Failure" || !(element instanceof HTMLElement)) {
        return ChartMessage.make({ success: false })
      }

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const values = Redacted.value(rows)
          const series = (kind: "room-created" | "transfer-completed" | "transfer-failed") => values.map(({ snapshot }) => snapshot?.byKind[kind] ?? 0)

          return new loaded.success.default(
            {
              width: Math.max(280, element.clientWidth),
              height: 240,
              scales: { x: { time: true } },
              axes: [{ stroke: color("--muted", "#5d584c") }, { stroke: color("--muted", "#5d584c") }],
              series: [
                {},
                { label: "Rooms created", stroke: color("--muted", "#5d584c"), width: 2 },
                { label: "Completed", stroke: color("--accent", "#8a5a00"), width: 2 },
                { label: "Failed", stroke: color("--text", "#1d1b16"), width: 2, dash: [6, 4] },
              ],
            },
            [values.map(({ hour }) => hour * 3600), series("room-created"), series("transfer-completed"), series("transfer-failed")],
            element,
          )
        }),
        (chart) =>
          Effect.sync(() => {
            chart.destroy()
          }),
      )

      return ChartMessage.make({ success: true })
    }),
})
