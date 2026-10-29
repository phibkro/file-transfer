import { describe, expect, it } from "vite-plus/test"
import { boundary, can, make, matrix, next, problems, toMermaid, toTable } from "../src/index.ts"

const door = make({
  name: "Door",
  states: ["Open", "Closed", "Removed"],
  commands: ["install", "close", "open", "remove"],
  terminal: ["Removed"],
  transitions: [
    { command: "install", from: [boundary], to: "Open" },
    { command: "close", from: ["Open"], to: "Closed" },
    { command: "open", from: ["Closed"], to: "Open", guard: (context: { readonly unlocked: boolean }) => context.unlocked },
    { command: "remove", from: ["Open", "Closed"], to: "Removed" },
  ],
})

describe("machine", () => {
  it("answers which command may run in which state, guards included", () => {
    expect(can(door, "close", "Open", { unlocked: false })).toBe(true)
    expect(can(door, "close", "Closed", { unlocked: false })).toBe(false)
    expect(can(door, "open", "Closed", { unlocked: false })).toBe(false)
    expect(next(door, "open", "Closed", { unlocked: true })).toBe("Open")
    expect(next(door, "install", "Open", { unlocked: true })).toBeUndefined()
  })

  it("finds nothing wrong with a well-formed machine", () => {
    expect(problems(door)).toEqual([])
  })

  it("reports unreachable states, undeclared dead ends, leaky terminals and unused commands", () => {
    const broken = make({
      name: "Broken",
      states: ["A", "B", "Island", "Done"],
      commands: ["start", "stop", "unused"],
      terminal: ["Done"],
      transitions: [
        { command: "start", from: [boundary], to: "A" },
        { command: "stop", from: ["A"], to: "B" },
        { command: "stop", from: ["Done"], to: "A" },
      ],
    })

    expect([...problems(broken)].toSorted()).toEqual(
      [
        "command unused has no transition",
        "state B has no way out but is not declared terminal",
        "state Done is unreachable from [*]",
        "state Island has no way out but is not declared terminal",
        "state Island is unreachable from [*]",
        "terminal state Done has a transition to another state",
      ].toSorted(),
    )
  })

  it("lists every state × command pair, the boundary included, with what the table says", () => {
    const cells = matrix(door)
    const outcomeOf = (state: string, command: string) => cells.find((cell) => cell.state === state && cell.command === command)?.outcome

    expect(cells).toHaveLength(4 * 4)
    expect(outcomeOf(boundary, "install")).toEqual({ kind: "moves", to: "Open" })
    expect(outcomeOf(boundary, "close")).toEqual({ kind: "rejected" })
    expect(outcomeOf("Open", "install")).toEqual({ kind: "rejected" })
    expect(outcomeOf("Closed", "open")).toEqual({ kind: "guarded", branches: [{ to: "Open" }] })
    expect(outcomeOf("Removed", "open")).toEqual({ kind: "rejected" })
  })

  it("reports a command whose transitions from one state cannot be told apart", () => {
    const ambiguous = make({
      name: "Ambiguous",
      states: ["A", "B", "Done"],
      commands: ["start", "go"],
      terminal: ["Done"],
      transitions: [
        { command: "start", from: [boundary], to: "A" },
        { command: "go", from: ["A"], to: "B" },
        { command: "go", from: ["A", "B"], to: "Done" },
      ],
    })

    expect(problems(ambiguous)).toEqual(["command go in state A has 2 transitions and not every one has a guard"])
  })

  it("renders the full matrix as a table, illegal inputs included", () => {
    expect(toTable(door).split("\n")).toEqual([
      "| State   | install  | close    | open                                   | remove   |",
      "| ------- | -------- | -------- | -------------------------------------- | -------- |",
      "| [*]     | Open     | rejected | rejected                               | rejected |",
      "| Open    | rejected | Closed   | rejected                               | Removed  |",
      "| Closed  | rejected | rejected | Open if its guard holds, else rejected | Removed  |",
      "| Removed | rejected | rejected | rejected                               | rejected |",
    ])
  })

  it("renders a top-to-bottom diagram", () => {
    const diagram = toMermaid(door)
    expect(diagram.startsWith("stateDiagram-v2\n  direction TB")).toBe(true)
    expect(diagram).toContain("Open --> Closed: close")
    expect(diagram).toContain("Removed --> [*]")
  })
})
