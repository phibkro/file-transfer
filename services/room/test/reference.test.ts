import { secureCrypto } from "@file-transfer/conformance"
import { Layer } from "effect"
import { describe, expect, it } from "bun:test"
import * as Machine from "@file-transfer/machine"
import { makeRoomReference, RoomReference, roomGuarantees, roomMachine } from "../src/index.ts"
import { roomSuite } from "./conformance.ts"

roomSuite.run("reference", Layer.provide(RoomReference, secureCrypto))
roomSuite.negativeControls(
  "reference",
  roomGuarantees.map((guarantee) => ({ violates: guarantee.identifier, layer: Layer.provide(makeRoomReference(new Set([guarantee.identifier])), secureCrypto) })),
)

describe("Room machine", () => {
  it("is well formed", () => {
    expect(Machine.problems(roomMachine)).toEqual([])
  })
})
