// oxlint-effect-plugin ignore-file:
// reason: the operator page's browser glue over fetch, the DOM and uPlot; no services to compose
/**
 * The operator page (`/admin`, docs/decisions/0019-open-source-first.md). It reads this instance's public settings
 * (`/api/instance`) and, with the operator's admin token, its counts (`/api/admin/counters`), and draws the last 48
 * hours with uPlot (MIT, leeoniya/uPlot). Only this page loads uPlot; senders and recipients never download it.
 *
 * The token is sent only to this instance's own `/api/admin` paths, in the Authorization header, and kept in this
 * tab's session storage until the tab closes or "Forget token" is pressed. Responses are decoded at the boundary.
 */
import uPlot from "uplot"
import "uplot/dist/uPlot.min.css"
import * as v from "valibot"
import { element, formatSize } from "./view.ts"

const kinds = ["room-created", "recipient-joined", "transfer-completed", "transfer-failed", "path-direct", "path-relayed"] as const

const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0))

const Snapshot = v.object({
  byKind: v.object({
    "room-created": count,
    "recipient-joined": count,
    "transfer-completed": count,
    "transfer-failed": count,
    "path-direct": count,
    "path-relayed": count,
  }),
  bySizeBucket: v.object({
    "under-10-megabytes": count,
    "under-1-gigabyte": count,
    "under-10-gigabytes": count,
    "10-gigabytes-or-more": count,
  }),
  relayedMegabytes: count,
})

type Snapshot = v.InferOutput<typeof Snapshot>

const Instance = v.object({
  limits: v.object({ roomsPerAddressPerHour: count, relayedBytesPerRoom: count }),
  counters: v.boolean(),
})

const Counters = v.variant("counters", [
  v.object({ counters: v.literal(false) }),
  v.object({
    counters: v.literal(true),
    kinds: v.record(v.string(), v.string()),
    total: Snapshot,
    hours: v.array(v.object({ hour: count, snapshot: Snapshot })),
  }),
])

const tokenKey = "file-transfer:admin-token"

const storedToken = (): string => {
  try {
    return sessionStorage.getItem(tokenKey) ?? ""
  } catch {
    return ""
  }
}

const storeToken = (token: string | undefined) => {
  try {
    if (token === undefined) {
      sessionStorage.removeItem(tokenKey)
    } else {
      sessionStorage.setItem(tokenKey, token)
    }
  } catch {
    // Storage unavailable: the token lives only in this page.
  }
}

const getJson = async (path: string, token?: string): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await fetch(path, { cache: "no-store", headers: token === undefined ? {} : { authorization: `Bearer ${token}` } })
  const body: unknown = response.headers.get("content-type")?.includes("json") === true ? await response.json() : undefined

  return { status: response.status, body }
}

/** "rooms created" as "Rooms created". */
const sentenceCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

const definitionList = (rows: readonly (readonly [string, string])[]) =>
  element(
    "dl",
    { class: "admin-facts" },
    rows.flatMap(([term, value]) => [element("dt", {}, [term]), element("dd", {}, [value])]),
  )

const settingsSection = async (): Promise<HTMLElement> => {
  const { body } = await getJson("/api/instance")
  const instance = v.safeParse(Instance, body)

  if (!instance.success) {
    return element("p", { role: "alert" }, ["This instance does not describe its settings (an older version)."])
  }

  const { limits, counters } = instance.output

  return element("section", { "aria-labelledby": "settings-heading" }, [
    element("h2", { id: "settings-heading" }, ["Settings"]),
    definitionList([
      ["Counting", counters ? "On" : "Off (set COUNTERS to on to count)"],
      ["Rooms per address per hour", String(limits.roomsPerAddressPerHour)],
      ["Relayed per transfer, at most", formatSize(limits.relayedBytesPerRoom)],
    ]),
  ])
}

/** The last 48 hours as rows, with hours nobody used filled with zeros. */
const lastHours = (hours: readonly { readonly hour: number; readonly snapshot: Snapshot }[], span: number) => {
  const byHour = new Map(hours.map((entry) => [entry.hour, entry.snapshot]))
  const now = Math.floor(Date.now() / 3_600_000)

  return Array.from({ length: span }, (_, index) => {
    const hour = now - span + 1 + index

    return { hour, snapshot: byHour.get(hour) }
  })
}

const color = (name: string, fallback: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

const chart = (rows: ReturnType<typeof lastHours>, container: HTMLElement) => {
  const series = (kind: (typeof kinds)[number]) => rows.map(({ snapshot }) => snapshot?.byKind[kind] ?? 0)
  const data: uPlot.AlignedData = [rows.map(({ hour }) => hour * 3600), series("room-created"), series("transfer-completed"), series("transfer-failed")]

  const options: uPlot.Options = {
    width: Math.max(280, container.clientWidth),
    height: 240,
    scales: { x: { time: true } },
    axes: [{ stroke: color("--muted", "#5d584c") }, { stroke: color("--muted", "#5d584c") }],
    series: [
      {},
      { label: "Rooms created", stroke: color("--muted", "#5d584c"), width: 2 },
      { label: "Completed", stroke: color("--accent", "#8a5a00"), width: 2 },
      { label: "Failed", stroke: color("--text", "#1d1b16"), width: 2, dash: [6, 4] },
    ],
  }

  return new uPlot(options, data, container)
}

const countsSection = (counters: Extract<v.InferOutput<typeof Counters>, { counters: true }>): HTMLElement => {
  const { total, kinds: descriptions } = counters
  const ended = total.byKind["transfer-completed"] + total.byKind["transfer-failed"]
  const completion = ended === 0 ? "no transfers have ended yet" : `${Math.round((total.byKind["transfer-completed"] / ended) * 1000) / 10}%`
  const rows = lastHours(counters.hours, 48)
  const relayedToday = rows.slice(-24).reduce((sum, { snapshot }) => sum + (snapshot?.relayedMegabytes ?? 0), 0)

  const chartContainer = element("div", {
    class: "admin-chart",
    role: "img",
    "aria-label": "Rooms created, completed and failed transfers per hour, last 48 hours",
  })

  const section = element("section", { "aria-labelledby": "counts-heading" }, [
    element("h2", { id: "counts-heading" }, ["Counts"]),
    definitionList([
      ["Completed, of transfers that ended", completion],
      ["Relayed in the last 24 hours", formatSize(relayedToday * 1_000_000)],
      ["Relayed since counting began", formatSize(total.relayedMegabytes * 1_000_000)],
    ]),
    element("h3", {}, ["Last 48 hours"]),
    chartContainer,
    element("h3", {}, ["Totals since counting began"]),
    element("div", { class: "table-wrap" }, [
      element("table", {}, [
        element("thead", {}, [element("tr", {}, [element("th", { scope: "col" }, ["What"]), element("th", { scope: "col" }, ["Count"])])]),
        element(
          "tbody",
          {},
          kinds.map((kind) =>
            element("tr", {}, [element("td", {}, [sentenceCase(descriptions[kind] ?? kind)]), element("td", {}, [String(total.byKind[kind])])]),
          ),
        ),
      ]),
    ]),
    element("p", { class: "admin-note" }, [
      "Prometheus and Grafana can read the totals at /api/admin/metrics with the same token (Authorization: Bearer <token>).",
    ]),
  ])

  // Drawn once the container is on the page, so it knows its width.
  requestAnimationFrame(() => {
    chart(rows, chartContainer)
  })

  return section
}

const tokenForm = (onSubmit: (token: string) => void, onForget: () => void): HTMLElement => {
  const input = element("input", { type: "password", id: "admin-token", autocomplete: "off", spellcheck: "false" })
  const show = element("button", { type: "submit", class: "primary" }, ["Show counts"])
  const forget = element("button", { type: "button" }, ["Forget token"])
  const form = element("form", { class: "admin-token" }, [element("label", { for: "admin-token" }, ["Admin token"]), input, show, forget])
  input.value = storedToken()
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    onSubmit(input.value.trim())
  })
  forget.addEventListener("click", () => {
    input.value = ""
    onForget()
  })

  return form
}

const start = async (main: HTMLElement) => {
  main.append(await settingsSection())
  const status = element("p", { class: "admin-status", role: "status" })
  let counts: HTMLElement | undefined

  const show = async (token: string) => {
    counts?.remove()
    counts = undefined

    if (token === "") {
      status.textContent = "Enter the admin token you set with `wrangler secret put ADMIN_TOKEN`."

      return
    }

    status.textContent = "Reading the counts."
    const { status: code, body } = await getJson("/api/admin/counters?hours=48", token)

    if (code === 404) {
      status.textContent = "This instance has no admin token, so its counts cannot be read here. Set one with `wrangler secret put ADMIN_TOKEN`."

      return
    }

    if (code === 401) {
      status.textContent = "That token is not this instance's admin token."
      storeToken(undefined)

      return
    }

    const decoded = v.safeParse(Counters, body)

    if (!decoded.success) {
      status.textContent = "The counts could not be read."

      return
    }

    storeToken(token)

    if (!decoded.output.counters) {
      status.textContent = "Counting is off on this instance. Set COUNTERS to on to start counting; nothing was counted before."

      return
    }

    status.textContent = ""
    counts = countsSection(decoded.output)
    main.append(counts)
  }

  main.append(
    tokenForm(
      (token) => {
        void show(token)
      },
      () => {
        storeToken(undefined)
        counts?.remove()
        status.textContent = "The token was forgotten."
      },
    ),
    status,
  )

  if (storedToken() !== "") {
    await show(storedToken())
  }
}

const main = document.querySelector<HTMLElement>("#admin")

if (main !== null) {
  void start(main)
}
