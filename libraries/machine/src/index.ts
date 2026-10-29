/**
 * State machines as transition tables (docs/decisions/0008).
 *
 * Lifted and simplified from Machine.make in phibkro/vektorprogrammet-reimagined
 * (packages/domain/src/kernel/machine.ts, that repository's ADR 0007), same author. Differences: commands are a
 * declared list of names instead of an RpcGroup, and guards are plain predicates over a context instead of Schema
 * checks with JSON representations. Kept: terminal states are required, calculated changes (made by time, not by a
 * command) are declared beside transitions, and one table drives the runtime check, the diagram and the tests.
 */

/** The pseudo-state before a resource exists (`from`) and after it is gone (`to`), as in a Mermaid state diagram. */
export const boundary = "[*]"

export type Boundary = typeof boundary

export interface Transition<State extends string, Command extends string, Context> {
  readonly command: Command
  readonly from: readonly (State | Boundary)[]
  readonly to: State | Boundary
  /** Shown on the diagram beside the command. */
  readonly when?: string
  readonly guard?: (context: Context) => boolean
}

/** A change that no command makes, such as an idle room expiring. It happens once its guard holds. */
export interface Calculated<State extends string, Context> {
  readonly from: State
  readonly to: State | Boundary
  /** Required: the diagram has no other way to say what triggers the change. */
  readonly when: string
  readonly guard: (context: Context) => boolean
}

export interface Machine<State extends string, Command extends string, Context = void> {
  readonly name: string
  readonly states: readonly State[]
  readonly commands: readonly Command[]
  /** States that only self-loops leave. Required: an empty list is a statement, never a default. */
  readonly terminal: readonly State[]
  readonly transitions: readonly Transition<State, Command, Context>[]
  readonly calculated: readonly Calculated<State, Context>[]
}

export const make = <const State extends string, const Command extends string, Context = void>(definition: {
  readonly name: string
  readonly states: readonly State[]
  readonly commands: readonly Command[]
  readonly terminal: readonly NoInfer<State>[]
  readonly transitions: readonly Transition<NoInfer<State>, NoInfer<Command>, Context>[]
  readonly calculated?: readonly Calculated<NoInfer<State>, Context>[]
}): Machine<State, Command, Context> => ({ ...definition, calculated: definition.calculated ?? [] })

/** The transitions of `command` that start from `state` and whose guard holds for `context`. */
export const available = <State extends string, Command extends string, Context>(
  machine: Machine<State, Command, Context>,
  command: NoInfer<Command>,
  state: State | Boundary,
  context: Context,
): readonly Transition<State, Command, Context>[] =>
  machine.transitions.filter(
    (transition) => transition.command === command && transition.from.includes(state) && (transition.guard === undefined || transition.guard(context)),
  )

/** Whether `command` may be applied in `state`. */
export const can = <State extends string, Command extends string, Context>(
  machine: Machine<State, Command, Context>,
  command: NoInfer<Command>,
  state: State | Boundary,
  context: Context,
): boolean => available(machine, command, state, context).length > 0

/** The state `command` leaves the resource in, or `undefined` when it may not be applied in `state`. */
export const next = <State extends string, Command extends string, Context>(
  machine: Machine<State, Command, Context>,
  command: NoInfer<Command>,
  state: State | Boundary,
  context: Context,
): State | Boundary | undefined => available(machine, command, state, context)[0]?.to

/**
 * What applying a command in a state does, read from the table alone. `guarded` means the outcome depends on the
 * context, so a test must supply one; `rejected` means the command may not run there and must leave the state as it was.
 */
export type Outcome<State extends string> =
  | { readonly kind: "moves"; readonly to: State | Boundary; readonly when?: string }
  | { readonly kind: "guarded"; readonly branches: readonly { readonly to: State | Boundary; readonly when?: string }[] }
  | { readonly kind: "rejected" }

/** One pair of the state × command matrix. */
export interface Cell<State extends string, Command extends string> {
  readonly state: State | Boundary
  readonly command: Command
  readonly outcome: Outcome<State>
}

/** The machine's states with the boundary first, the rows of its state × command matrix. */
const rowsOf = <State extends string, Command extends string, Context>(machine: Machine<State, Command, Context>): readonly (State | Boundary)[] => [
  boundary,
  ...machine.states,
]

/** The transitions of `command` that start from `state`, whatever their guards say. */
const declared = <State extends string, Command extends string, Context>(
  machine: Machine<State, Command, Context>,
  command: Command,
  state: State | Boundary,
): readonly Transition<State, Command, Context>[] =>
  machine.transitions.filter((transition) => transition.command === command && transition.from.includes(state))

/**
 * Every (state, command) pair, the boundary included, with what the table says happens. The rejected pairs are the
 * illegal inputs a test must try: a table that only lists its transitions says nothing about the rest unless something
 * checks them (Binder's "sneak paths").
 */
export const matrix = <State extends string, Command extends string, Context>(machine: Machine<State, Command, Context>): readonly Cell<State, Command>[] =>
  rowsOf(machine).flatMap((state) =>
    machine.commands.map((command): Cell<State, Command> => {
      const matching = declared(machine, command, state)
      const [only] = matching

      if (only === undefined) {
        return { state, command, outcome: { kind: "rejected" } }
      }

      if (matching.length === 1 && only.guard === undefined) {
        return { state, command, outcome: only.when === undefined ? { kind: "moves", to: only.to } : { kind: "moves", to: only.to, when: only.when } }
      }

      return {
        state,
        command,
        outcome: {
          kind: "guarded",
          branches: matching.map((transition) => (transition.when === undefined ? { to: transition.to } : { to: transition.to, when: transition.when })),
        },
      }
    }),
  )

/** What makes a declaration incomplete or contradictory; an empty list means the machine is well formed. */
export const problems = <State extends string, Command extends string, Context>(machine: Machine<State, Command, Context>): readonly string[] => {
  const found: string[] = []

  // SAFETY: a command is a string, and a calculated change starts from a State, which State | Boundary includes.
  const edges = [
    ...machine.transitions.flatMap((transition) => transition.from.map((from) => ({ from, to: transition.to, label: transition.command as string }))),
    ...machine.calculated.map((change) => ({ from: change.from as State | Boundary, to: change.to, label: change.when })),
  ]

  const reachable = new Set<string>([boundary])
  let grew = true

  while (grew) {
    grew = false

    for (const edge of edges) {
      if (reachable.has(edge.from) && !reachable.has(edge.to)) {
        reachable.add(edge.to)
        grew = true
      }
    }
  }

  for (const state of machine.states) {
    if (!reachable.has(state)) {
      found.push(`state ${state} is unreachable from ${boundary}`)
    }

    const leaves = edges.some((edge) => edge.from === state && edge.to !== state)
    const isTerminal = machine.terminal.includes(state)

    if (isTerminal && leaves) {
      found.push(`terminal state ${state} has a transition to another state`)
    }

    if (!isTerminal && !leaves) {
      found.push(`state ${state} has no way out but is not declared terminal`)
    }
  }

  for (const command of machine.commands) {
    if (!machine.transitions.some((transition) => transition.command === command)) {
      found.push(`command ${command} has no transition`)
    }

    for (const state of rowsOf(machine)) {
      const matching = declared(machine, command, state)

      if (matching.length > 1 && matching.some((transition) => transition.guard === undefined)) {
        found.push(`command ${command} in state ${state} has ${matching.length} transitions and not every one has a guard`)
      }
    }
  }

  return found
}

/** The machine as a Mermaid state diagram, top to bottom. */
export const toMermaid = <State extends string, Command extends string, Context>(machine: Machine<State, Command, Context>): string => {
  const lines = ["stateDiagram-v2", "  direction TB"]

  for (const transition of machine.transitions) {
    const label = transition.when === undefined ? transition.command : `${transition.command} (${transition.when})`

    for (const from of transition.from) {
      lines.push(`  ${from} --> ${transition.to}: ${label}`)
    }
  }

  for (const change of machine.calculated) {
    lines.push(`  ${change.from} --> ${change.to}: ${change.when}`)
  }

  for (const state of machine.terminal) {
    lines.push(`  ${state} --> [*]`)
  }

  return lines.join("\n")
}

const describeOutcome = <State extends string>(outcome: Outcome<State>): string => {
  if (outcome.kind === "rejected") {
    return "rejected"
  }

  if (outcome.kind === "moves") {
    return outcome.when === undefined ? outcome.to : `${outcome.to} (${outcome.when})`
  }

  const branches = outcome.branches.map((branch) => `${branch.to} if ${branch.when ?? "its guard holds"}`)

  return `${branches.join(", ")}, else rejected`
}

/**
 * The full state × command matrix as a Markdown table: one row per state (the boundary first), one column per command,
 * each cell naming the state the command leaves the resource in or saying that it is rejected. The diagram shows the
 * transitions; this table also shows every illegal input, so it is the one a specification cites. Columns are padded
 * to equal width, as a Markdown formatter would leave them, so a generated document survives formatting unchanged.
 */
export const toTable = <State extends string, Command extends string, Context>(machine: Machine<State, Command, Context>): string => {
  const cells = matrix(machine)

  const rows: readonly (readonly string[])[] = rowsOf(machine).map((state) => [
    state,
    ...machine.commands.map((command) => {
      const cell = cells.find((candidate) => candidate.state === state && candidate.command === command)

      return cell === undefined ? "rejected" : describeOutcome(cell.outcome)
    }),
  ])

  const header = ["State", ...machine.commands]
  const widths = header.map((title, column) => Math.max(3, title.length, ...rows.map((row) => row[column]?.length ?? 0)))
  const line = (row: readonly string[]) => `| ${row.map((text, column) => text.padEnd(widths[column] ?? 0)).join(" | ")} |`

  return [line(header), `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`, ...rows.map(line)].join("\n")
}
