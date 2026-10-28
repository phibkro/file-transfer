import { describe, expect, it } from "vite-plus/test"
import { boundary, can, make, next, problems, toMermaid } from "../src/index.ts"

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

  it("renders a top-to-bottom diagram", () => {
    const diagram = toMermaid(door)
    expect(diagram.startsWith("stateDiagram-v2\n  direction TB")).toBe(true)
    expect(diagram).toContain("Open --> Closed: close")
    expect(diagram).toContain("Removed --> [*]")
  })
})
