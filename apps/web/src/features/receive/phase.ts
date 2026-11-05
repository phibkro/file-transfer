/**
 * The recipient's life cycle as a transition table (docs/decisions/0008). recipient.ts moves through it on every
 * event that changes what the recipient may do, and an event the table rejects in the current phase has no effect.
 *
 * Before this table the life cycle was a `finished` flag shared by saving, failing and declining, so the code could not
 * tell them apart (docs/spikes/0006): a failed commit never told the sender (R1), Accept and Decline still acted after
 * a failure (R2), and an abort while storage opened was overwritten once it opened (R3). Connection state (joined,
 * reconnecting, whether the sender is present) is separate: it changes how the recipient talks, not what it may do.
 */
import * as Machine from "@file-transfer/machine"

export const recipientMachine = Machine.make({
  name: "Recipient",
  states: ["Opening", "Reviewing", "OpeningStorage", "Receiving", "Committing", "Completed", "Declined", "Failed"],
  commands: ["open", "contractOpened", "accept", "decline", "storageOpened", "lastRecordStored", "commitSucceeded", "commitFailed", "fail"],
  terminal: ["Completed", "Declined", "Failed"],
  transitions: [
    { command: "open", from: [Machine.boundary], to: "Opening", when: "the link decodes" },
    { command: "contractOpened", from: ["Opening"], to: "Reviewing" },
    { command: "accept", from: ["Reviewing"], to: "OpeningStorage" },
    { command: "decline", from: ["Reviewing"], to: "Declined" },
    { command: "storageOpened", from: ["OpeningStorage"], to: "Receiving" },
    { command: "lastRecordStored", from: ["Receiving"], to: "Committing" },
    { command: "commitSucceeded", from: ["Committing"], to: "Completed" },
    { command: "commitFailed", from: ["Committing"], to: "Failed" },
    {
      command: "fail",
      from: ["Opening", "Reviewing", "OpeningStorage", "Receiving"],
      to: "Failed",
      when: "a parcel error, an abort from the sender, or an error from the room",
    },
  ],
})

export type RecipientPhase = (typeof recipientMachine.states)[number]

export type RecipientCommand = (typeof recipientMachine.commands)[number]

/** The phase `command` leads to from `phase`, or undefined when the table rejects it there. */
export const nextPhase = (phase: RecipientPhase, command: RecipientCommand): RecipientPhase | undefined => {
  const next = Machine.next(recipientMachine, command, phase, undefined)

  return next === undefined || next === Machine.boundary ? undefined : next
}

/** Accepted and still receiving: the phases in which records, label pages and resumes are wanted. */
export const isAccepted = (phase: RecipientPhase): boolean => phase === "OpeningStorage" || phase === "Receiving"

/** No more records are wanted: the files are being saved, or the transfer ended one way or another. */
export const isSettled = (phase: RecipientPhase): boolean => phase === "Committing" || recipientMachine.terminal.includes(phase)
