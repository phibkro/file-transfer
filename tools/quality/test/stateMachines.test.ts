import { describe, expect, it } from "vite-plus/test"
import { textNow } from "../src/repository.ts"
import { stateMachineDocument, stateMachinesFile } from "../src/stateMachines.ts"

const root = new URL("../../../", import.meta.url).pathname

describe("state machine document", () => {
  it("matches the transition tables (run `bun run docs:machines` to regenerate)", () => {
    expect(textNow(root, stateMachinesFile)).toBe(stateMachineDocument())
  })
})
