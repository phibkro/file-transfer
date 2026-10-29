/**
 * Seeded fault plans for the chaos suite of the end-to-end checks (endToEnd.ts, `E2E_SUITE=chaos`). Pure: a seed
 * always gives the same plan, so a failing run replays exactly with `E2E_SEED`.
 *
 * Both of the app's connections are reliable transports (the room socket is TCP, the data channel is reliable SCTP),
 * so lost packets never reach the app; it sees what the faults below produce: connections that end with records in
 * flight, connections that go silent, stalls, latency, a relay that replays records, and a direct path that dies.
 */

/** Which side of the transfer a fault hits. */
export type Side = "sender" | "recipient"

export type Fault =
  /** Both ends of the side's socket close, as when the server restarts. */
  | { readonly kind: "cut-clean" }
  /** Only the browser's end closes; the server never hears it, as after a network change. */
  | { readonly kind: "cut-half-open" }
  /** Nothing passes either way for a while, then everything queued arrives in order, as on a congested link. */
  | { readonly kind: "stall"; readonly milliseconds: number }
  /** The socket stays open but nothing passes either way again, as when a NAT forgets the connection. */
  | { readonly kind: "blackhole" }
  /** Every later frame waits up to this long, in order, as on a slow or distant link. */
  | { readonly kind: "latency"; readonly milliseconds: number }
  /** The relay sends this side records it already sent, as a buggy or hostile relay might. */
  | { readonly kind: "replay"; readonly frames: number }
  /** The side's direct path (data channel and peer connection) dies, as when ICE fails mid-transfer. */
  | { readonly kind: "direct-drop" }

export interface PlannedFault {
  /** The recipient's progress, as a fraction of the total, at which the fault strikes. */
  readonly at: number
  readonly side: Side
  readonly fault: Fault
}

export interface FaultPlan {
  readonly seed: number
  /** Whether the run allows a direct path; faults on the relay need a run without one. */
  readonly direct: boolean
  readonly faults: readonly PlannedFault[]
}

/** mulberry32: a small, fast, seedable generator; plenty for choosing faults. */
export const randomSource = (seed: number): (() => number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

const between = (random: () => number, low: number, high: number): number => low + Math.floor(random() * (high - low + 1))

const pick = <Value>(random: () => number, values: readonly [Value, ...Value[]]): Value => values[Math.floor(random() * values.length)] ?? values[0]

const faultFor = (random: () => number, direct: boolean): Fault => {
  const kinds: readonly [Fault["kind"], ...Fault["kind"][]] = [
    "cut-clean",
    "cut-half-open",
    "stall",
    "blackhole",
    "latency",
    "replay",
    ...(direct ? (["direct-drop", "direct-drop"] as const) : []),
  ]

  const kind = pick(random, kinds)

  switch (kind) {
    case "stall": {
      return { kind, milliseconds: between(random, 1000, 8000) }
    }

    case "latency": {
      return { kind, milliseconds: between(random, 20, 200) }
    }

    case "replay": {
      return { kind, frames: between(random, 1, 8) }
    }

    case "cut-clean":
    case "cut-half-open":
    case "blackhole":
    case "direct-drop": {
      return { kind }
    }
  }
}

/** Two to four faults at increasing points of the transfer, on either side, with or without a direct path. */
export const faultPlan = (seed: number): FaultPlan => {
  const random = randomSource(seed)
  const direct = random() < 0.5
  const count = between(random, 2, 4)
  const points = Array.from({ length: count }, () => 0.05 + random() * 0.85).toSorted((left, right) => left - right)
  const faults = points.map((at) => ({ at, side: pick<Side>(random, ["sender", "recipient"]), fault: faultFor(random, direct) }))

  return { seed, direct, faults }
}

const detailOf = (fault: Fault): string => {
  if ("milliseconds" in fault) {
    return ` ${fault.milliseconds} ms`
  }

  return "frames" in fault ? ` ${fault.frames} frames` : ""
}

/** One line per fault, for the log of a run. */
export const describePlan = (plan: FaultPlan): string =>
  [
    `seed ${plan.seed}, ${plan.direct ? "direct allowed" : "relay only"}`,
    ...plan.faults.map(({ at, side, fault }) => `  at ${Math.round(at * 100)}%: ${side} ${fault.kind}${detailOf(fault)}`),
  ].join("\n")
