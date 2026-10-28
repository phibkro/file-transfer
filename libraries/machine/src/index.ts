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
  readonly from: ReadonlyArray<State | Boundary>
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
  readonly states: ReadonlyArray<State>
  readonly commands: ReadonlyArray<Command>
  /** States that only self-loops leave. Required: an empty list is a statement, never a default. */
  readonly terminal: ReadonlyArray<State>
  readonly transitions: ReadonlyArray<Transition<State, Command, Context>>
  readonly calculated: ReadonlyArray<Calculated<State, Context>>
}

export const make = <const State extends string, const Command extends string, Context = void>(definition: {
  readonly name: string
  readonly states: ReadonlyArray<State>
  readonly commands: ReadonlyArray<Command>
  readonly terminal: ReadonlyArray<NoInfer<State>>
  readonly transitions: ReadonlyArray<Transition<NoInfer<State>, NoInfer<Command>, Context>>
  readonly calculated?: ReadonlyArray<Calculated<NoInfer<State>, Context>>
}): Machine<State, Command, Context> => ({ ...definition, calculated: definition.calculated ?? [] })

/** The transitions of `command` that start from `state` and whose guard holds for `context`. */
export const available = <State extends string, Command extends string, Context>(
  machine: Machine<State, Command, Context>,
  command: NoInfer<Command>,
  state: State | Boundary,
  context: Context,
): ReadonlyArray<Transition<State, Command, Context>> =>
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

/** What makes a declaration incomplete or contradictory; an empty list means the machine is well formed. */
export const problems = <State extends string, Command extends string, Context>(machine: Machine<State, Command, Context>): ReadonlyArray<string> => {
  const found: Array<string> = []
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
    if (!reachable.has(state)) found.push(`state ${state} is unreachable from ${boundary}`)
    const leaves = edges.some((edge) => edge.from === state && edge.to !== state)
    const isTerminal = machine.terminal.includes(state)
    if (isTerminal && leaves) found.push(`terminal state ${state} has a transition to another state`)
    if (!isTerminal && !leaves) found.push(`state ${state} has no way out but is not declared terminal`)
  }
  for (const command of machine.commands) {
    if (!machine.transitions.some((transition) => transition.command === command)) found.push(`command ${command} has no transition`)
  }
  return found
}

/** The machine as a Mermaid state diagram, top to bottom. */
export const toMermaid = <State extends string, Command extends string, Context>(machine: Machine<State, Command, Context>): string => {
  const lines = ["stateDiagram-v2", "  direction TB"]
  for (const transition of machine.transitions) {
    const label = transition.when === undefined ? transition.command : `${transition.command} (${transition.when})`
    for (const from of transition.from) lines.push(`  ${from} --> ${transition.to}: ${label}`)
  }
  for (const change of machine.calculated) lines.push(`  ${change.from} --> ${change.to}: ${change.when}`)
  for (const state of machine.terminal) lines.push(`  ${state} --> [*]`)
  return lines.join("\n")
}
