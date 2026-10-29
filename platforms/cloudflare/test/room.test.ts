/**
 * The room's decisions, one describe per rule of docs/protocol.md, each with the case it must allow and the case it
 * must refuse. Token hashes come from the parcel test vectors (libraries/parcel/test/vectors/vectors.json).
 */
import { decodeControlMessage, encodeControlMessage } from "@file-transfer/transport"
import type { ControlMessage } from "@file-transfer/transport"
import { describe, expect, it } from "vite-plus/test"
import {
  decide,
  decodeCreateRoom,
  encodeRoomIdentifier,
  errorReasons,
  joinTokenOf,
  maximumTextLength,
  roomIdentifierPattern,
  violationCloseCode,
} from "../src/room.ts"
import type { Admission, Attachment, Instruction, Participant, RoomRecord } from "../src/room.ts"

const roomToken = "c123f8631c7587e150411d4221c44c682b288fdeb07bc3e0224b312b8d71ff35"
const roomTokenHash = "73319e970435543e1c8bffbfc146f114897920579cc850fb0393eda79d89c085"
const otherHash = "0".repeat(64)

const record = (maximumRecipients = 2): RoomRecord => ({ roomTokenHash, maximumRecipients })
const fresh: Attachment = { admitted: false }
const sender: Participant = { role: "sender", participantIdentifier: "sender-1" }
const recipient = (index: number): Participant => ({ role: "recipient", participantIdentifier: `recipient-${index}` })
const as = (participant: Participant): Attachment => ({ admitted: true, ...participant })

const joinText = (role: "sender" | "recipient") => encodeControlMessage({ type: "join", role, roomToken })

const admission = (presentedTokenHash = roomTokenHash, maximumRecipients = 2): Admission => ({
  record: record(maximumRecipients),
  presentedTokenHash,
  participantIdentifier: "new-participant",
})

const joinAs = (role: "sender" | "recipient", participants: readonly Participant[], presented = roomTokenHash, maximumRecipients = 2) =>
  decide(fresh, participants, { type: "text", text: joinText(role), admission: admission(presented, maximumRecipients) })

const decoded = (text: string): ControlMessage => {
  const result = decodeControlMessage(text)

  if (!result.ok) {
    throw new Error(`not a control message: ${text}`)
  }

  return result.value
}

/** Asserts the room answered with an error naming `reason` and then closed the socket as a violation. */
const expectViolation = (instructions: readonly Instruction[], reason: string) => {
  expect(instructions).toHaveLength(2)
  const [reply, close] = instructions
  expect(reply?.type === "reply" && decoded(reply.text)).toEqual({ type: "error", reason })
  expect(close).toEqual({ type: "close", code: violationCloseCode, reason })
}

const admitted = (instructions: readonly Instruction[]) => instructions.find((instruction) => instruction.type === "admit")

describe("room creation", () => {
  it("accepts a token hash and a recipient limit of 1 to 16", () => {
    expect(decodeCreateRoom({ roomTokenHash, maximumRecipients: 1 })).toEqual({ roomTokenHash, maximumRecipients: 1 })
    expect(decodeCreateRoom({ roomTokenHash, maximumRecipients: 16 })).toEqual({ roomTokenHash, maximumRecipients: 16 })
  })

  it("keeps only the declared fields", () => {
    expect(decodeCreateRoom({ roomTokenHash, maximumRecipients: 3, roomToken, fileName: "secret.pdf" })).toEqual({ roomTokenHash, maximumRecipients: 3 })
  })

  it("refuses malformed hashes and limits out of range", () => {
    for (const body of [
      { roomTokenHash: roomTokenHash.toUpperCase(), maximumRecipients: 1 },
      { roomTokenHash: roomTokenHash.slice(1), maximumRecipients: 1 },
      { roomTokenHash, maximumRecipients: 0 },
      { roomTokenHash, maximumRecipients: 17 },
      { roomTokenHash, maximumRecipients: 1.5 },
      { roomTokenHash },
      null,
      "text",
    ]) {
      expect(decodeCreateRoom(body)).toBeUndefined()
    }
  })

  it("encodes 16 bytes as a 22-character base64url identifier", () => {
    const identifier = encodeRoomIdentifier(new Uint8Array(16).fill(0xfb))
    expect(identifier).toMatch(roomIdentifierPattern)
    expect(identifier).toBe("-_v7-_v7-_v7-_v7-_v7-w")
  })
})

describe("admission compares the token hash", () => {
  it("admits a join whose token hash matches", () => {
    const instructions = joinAs("recipient", [])
    expect(admitted(instructions)).toEqual({ type: "admit", participant: { role: "recipient", participantIdentifier: "new-participant" } })
    const reply = instructions.find((instruction) => instruction.type === "reply")
    expect(reply?.type === "reply" && decoded(reply.text)).toEqual({
      type: "joined",
      participantIdentifier: "new-participant",
      senderPresent: false,
      recipientCount: 1,
      answersPings: true,
    })
  })

  it("refuses a join whose token hash differs", () => {
    expectViolation(joinAs("recipient", [], otherHash), errorReasons.wrongToken)
  })

  it("refuses a hash of another length", () => {
    expectViolation(joinAs("sender", [], roomTokenHash.slice(2)), errorReasons.wrongToken)
  })

  it("finds the token of a join and nothing else", () => {
    expect(joinTokenOf(joinText("sender"))).toBe(roomToken)
    expect(joinTokenOf(encodeControlMessage({ type: "credit", records: 1 }))).toBeUndefined()
    expect(joinTokenOf(`{"type":"join","role":"sender","roomToken":"${roomToken.toUpperCase()}"}`)).toBeUndefined()
  })
})

describe("nothing before join", () => {
  it("refuses a binary frame before join", () => {
    expectViolation(decide(fresh, [sender], { type: "binary" }), errorReasons.joinFirst)
  })

  it("refuses a control message other than join before join", () => {
    expectViolation(decide(fresh, [sender], { type: "text", text: encodeControlMessage({ type: "credit", records: 4 }) }), errorReasons.notAJoin)
  })

  it("refuses text that is not a control message before join", () => {
    expectViolation(decide(fresh, [], { type: "text", text: "hello" }), errorReasons.notAJoin)
  })

  it("refuses a join the adapter did not prepare an admission for", () => {
    expectViolation(decide(fresh, [], { type: "text", text: joinText("sender") }), errorReasons.notAJoin)
  })

  it("refuses a second join on an admitted socket", () => {
    expectViolation(decide(as(sender), [sender], { type: "text", text: joinText("sender") }), errorReasons.alreadyJoined)
  })

  it("lets a socket that never joined leave silently", () => {
    expect(decide(fresh, [sender], { type: "close" })).toEqual([])
  })
})

describe("one sender", () => {
  it("admits a sender into a room without one", () => {
    const instructions = joinAs("sender", [recipient(1)])
    expect(admitted(instructions)).toBeDefined()
    const reply = instructions.find((instruction) => instruction.type === "reply")
    expect(reply?.type === "reply" && decoded(reply.text)).toEqual({
      type: "joined",
      participantIdentifier: "new-participant",
      senderPresent: true,
      recipientCount: 1,
      answersPings: true,
    })
  })

  it("replaces the present sender with a newer sender join, without telling recipients it left", () => {
    const instructions = joinAs("sender", [sender, recipient(1)])
    expect(instructions[0]).toEqual({ type: "evict", participantIdentifier: "sender-1", reason: errorReasons.replaced })
    expect(admitted(instructions)).toBeDefined()
    const reply = instructions.find((instruction) => instruction.type === "reply")
    expect(reply?.type === "reply" && decoded(reply.text)).toMatchObject({ senderPresent: true, recipientCount: 1 })
    const relays = instructions.filter((instruction) => instruction.type === "relay")
    expect(relays.map((relay) => relay.type === "relay" && decoded(relay.text))).toEqual([{ type: "peer", event: "joined", role: "sender" }])
  })

  it("does not let a wrong token replace anyone", () => {
    expectViolation(joinAs("sender", [sender], "0".repeat(64)), errorReasons.wrongToken)
  })
})

describe("at most maximumRecipients recipients", () => {
  it("admits recipients up to the limit", () => {
    expect(admitted(joinAs("recipient", [sender, recipient(1)], roomTokenHash, 2))).toBeDefined()
  })

  it("replaces the oldest recipient when a join would exceed the limit", () => {
    const instructions = joinAs("recipient", [sender, recipient(1), recipient(2)], roomTokenHash, 2)
    expect(instructions.filter((instruction) => instruction.type === "evict")).toEqual([
      { type: "evict", participantIdentifier: "recipient-1", reason: errorReasons.replaced },
    ])
    const reply = instructions.find((instruction) => instruction.type === "reply")
    expect(reply?.type === "reply" && decoded(reply.text)).toMatchObject({ senderPresent: true, recipientCount: 2 })
  })

  it("replaces the only recipient of a one-recipient room, the reconnect case", () => {
    const instructions = joinAs("recipient", [sender, recipient(1)], roomTokenHash, 1)
    expect(instructions[0]).toEqual({ type: "evict", participantIdentifier: "recipient-1", reason: errorReasons.replaced })
    expect(admitted(instructions)).toBeDefined()
  })

  it("evicts nobody below the limit", () => {
    expect(joinAs("recipient", [sender, recipient(1)], roomTokenHash, 2).some((instruction) => instruction.type === "evict")).toBe(false)
  })

  it("does not count the sender against the recipient limit", () => {
    expect(admitted(joinAs("recipient", [sender], roomTokenHash, 1))).toBeDefined()
  })
})

describe("binary frames flow only from the sender to every admitted recipient", () => {
  it("forwards a sender's frame to every recipient", () => {
    expect(decide(as(sender), [sender, recipient(1), recipient(2)], { type: "binary" })).toEqual([{ type: "forwardFrame", to: ["recipient-1", "recipient-2"] }])
  })

  it("forwards to nobody when no recipient is present", () => {
    expect(decide(as(sender), [sender], { type: "binary" })).toEqual([{ type: "forwardFrame", to: [] }])
  })

  it("refuses a recipient's frame", () => {
    expectViolation(decide(as(recipient(1)), [sender, recipient(1)], { type: "binary" }), errorReasons.framesFromSenderOnly)
  })
})

describe("recipient control messages go to the sender", () => {
  const relayed: readonly ControlMessage[] = [
    { type: "accept", sequence: 1, digest: "a".repeat(64) },
    { type: "decline", sequence: 1 },
    { type: "credit", records: 64 },
    { type: "want", sequence: 1, ranges: [[0, 4]] },
    { type: "complete", sequence: 1 },
    { type: "abort", reason: "cancelled" },
  ]

  for (const message of relayed) {
    it(`relays ${message.type} to the sender as received`, () => {
      const text = encodeControlMessage(message)
      expect(decide(as(recipient(1)), [sender, recipient(1), recipient(2)], { type: "text", text })).toEqual([{ type: "relay", to: ["sender-1"], text }])
    })
  }

  it("relays the text unchanged, including fields the room does not know", () => {
    const text = `{"type":"credit","records":8,"extension":true}`
    expect(decide(as(recipient(1)), [sender], { type: "text", text })).toEqual([{ type: "relay", to: ["sender-1"], text }])
  })

  it("drops a recipient message while no sender is present", () => {
    expect(decide(as(recipient(1)), [recipient(1)], { type: "text", text: encodeControlMessage({ type: "credit", records: 1 }) })).toEqual([])
  })

  it("refuses messages recipients may not send", () => {
    for (const message of [
      { type: "joined", participantIdentifier: "x", senderPresent: true, recipientCount: 1 },
      { type: "peer", event: "joined", role: "sender" },
      { type: "error", reason: "spoofed" },
      { type: "unknown" },
    ]) {
      expectViolation(decide(as(recipient(1)), [sender], { type: "text", text: JSON.stringify(message) }), errorReasons.notAllowedForRecipient)
    }
  })

  it("refuses text that is not a control message", () => {
    for (const text of ["not json", "[]", "null", `{"records":1}`, `{"type":7}`]) {
      expectViolation(decide(as(recipient(1)), [sender], { type: "text", text }), errorReasons.notAControlMessage)
    }
  })

  it("refuses text longer than the limit", () => {
    const text = `{"type":"abort","reason":"${"x".repeat(maximumTextLength)}"}`
    expectViolation(decide(as(recipient(1)), [sender], { type: "text", text }), errorReasons.textTooLong)
  })
})

describe("sender abort goes to the recipients", () => {
  it("relays the sender's abort to every recipient", () => {
    const text = encodeControlMessage({ type: "abort", reason: "cancelled" })
    expect(decide(as(sender), [sender, recipient(1), recipient(2)], { type: "text", text })).toEqual([
      { type: "relay", to: ["recipient-1", "recipient-2"], text },
    ])
  })

  it("refuses any other control message from the sender", () => {
    for (const message of [
      { type: "credit", records: 1 },
      { type: "accept", sequence: 1, digest: "a".repeat(64) },
      { type: "complete", sequence: 1 },
    ]) {
      expectViolation(decide(as(sender), [sender, recipient(1)], { type: "text", text: JSON.stringify(message) }), errorReasons.notAllowedForSender)
    }
  })
})

const peerTexts = (instructions: readonly Instruction[]) =>
  instructions.flatMap((instruction) => (instruction.type === "relay" ? [{ to: instruction.to, message: decoded(instruction.text) }] : []))

describe("peer presence events", () => {
  it("tells the sender when a recipient joins, and not the other recipients", () => {
    expect(peerTexts(joinAs("recipient", [sender, recipient(1)]))).toEqual([
      { to: ["sender-1"], message: { type: "peer", event: "joined", role: "recipient" } },
    ])
  })

  it("tells every recipient when the sender joins", () => {
    expect(peerTexts(joinAs("sender", [recipient(1), recipient(2)]))).toEqual([
      { to: ["recipient-1", "recipient-2"], message: { type: "peer", event: "joined", role: "sender" } },
    ])
  })

  it("tells the other side when a participant leaves", () => {
    expect(peerTexts(decide(as(recipient(1)), [sender, recipient(2)], { type: "close" }))).toEqual([
      { to: ["sender-1"], message: { type: "peer", event: "left", role: "recipient" } },
    ])
    expect(peerTexts(decide(as(sender), [recipient(1), recipient(2)], { type: "close" }))).toEqual([
      { to: ["recipient-1", "recipient-2"], message: { type: "peer", event: "left", role: "sender" } },
    ])
  })

  it("sends no presence event when nobody is on the other side", () => {
    expect(peerTexts(joinAs("sender", []))).toEqual([])
    expect(decide(as(sender), [], { type: "close" })).toEqual([])
  })

  it("never sends a presence event on a refused join", () => {
    expect(peerTexts(joinAs("recipient", [sender], otherHash))).toEqual([])
  })
})
