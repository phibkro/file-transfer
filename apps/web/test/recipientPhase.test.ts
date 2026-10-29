import * as Machine from "@file-transfer/machine"
import { describe, expect, it } from "vite-plus/test"
import { isAccepted, isSettled, nextPhase, recipientMachine } from "../src/recipientPhase.ts"
import type { RecipientCommand, RecipientPhase } from "../src/recipientPhase.ts"

/** The phase a sequence of commands ends in from Opening, or the first command the table rejects. */
const run = (commands: readonly RecipientCommand[]) => {
  let phase: RecipientPhase = "Opening"

  for (const command of commands) {
    const next = nextPhase(phase, command)

    if (next === undefined) {
      return { phase, rejected: command }
    }

    phase = next
  }

  return { phase, rejected: undefined }
}

describe("recipient phase", () => {
  it("is a well-formed machine", () => {
    expect(Machine.problems(recipientMachine)).toEqual([])
  })

  it("reaches Completed along the happy path", () => {
    expect(run(["contractOpened", "accept", "storageOpened", "lastRecordStored", "commitSucceeded"])).toEqual({ phase: "Completed", rejected: undefined })
  })

  it("fails when saving the files fails, so the sender is told and storage discarded (spike 0006, R1)", () => {
    expect(run(["contractOpened", "accept", "storageOpened", "lastRecordStored", "commitFailed"])).toEqual({ phase: "Failed", rejected: undefined })
  })

  it("ignores an abort while the files are being saved, as before", () => {
    expect(run(["contractOpened", "accept", "storageOpened", "lastRecordStored", "fail"])).toEqual({ phase: "Committing", rejected: "fail" })
  })

  it("rejects Accept and Decline after a failure (spike 0006, R2)", () => {
    expect(run(["contractOpened", "fail", "accept"])).toEqual({ phase: "Failed", rejected: "accept" })
    expect(run(["contractOpened", "fail", "decline"])).toEqual({ phase: "Failed", rejected: "decline" })
  })

  it("rejects storage that opens after the transfer failed (spike 0006, R3)", () => {
    expect(run(["contractOpened", "accept", "fail", "storageOpened"])).toEqual({ phase: "Failed", rejected: "storageOpened" })
  })

  it("rejects a second decision", () => {
    expect(run(["contractOpened", "accept", "decline"])).toEqual({ phase: "OpeningStorage", rejected: "decline" })
    expect(run(["contractOpened", "decline", "accept"])).toEqual({ phase: "Declined", rejected: "accept" })
  })

  it("rejects every command in every terminal phase", () => {
    for (const phase of recipientMachine.terminal) {
      for (const command of recipientMachine.commands) {
        expect(nextPhase(phase, command), `${command} in ${phase}`).toBeUndefined()
      }
    }
  })

  it("wants records only while accepted, and nothing once settled", () => {
    const accepted = recipientMachine.states.filter(isAccepted)
    const settled = recipientMachine.states.filter(isSettled)
    expect(accepted).toEqual(["OpeningStorage", "Receiving"])
    expect(settled).toEqual(["Committing", "Completed", "Declined", "Failed"])
  })
})
