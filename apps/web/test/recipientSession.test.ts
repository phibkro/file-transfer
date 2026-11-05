import { describe, expect, it, vi } from "vite-plus/test"
import { createRecipientSession } from "../src/features/receive/session.ts"

const boundary = vi.hoisted(() => ({ direct: vi.fn(), connect: vi.fn() }))

vi.mock("../src/capabilities/connection/directSettings.ts", () => ({ directOption: boundary.direct }))

vi.mock("../src/capabilities/connection/connection.ts", () => ({ openConnection: boundary.connect }))

describe("recipient session", () => {
  it("reports an invalid link and stops publishing after disposal", async () => {
    const session = createRecipientSession("room", "not-a-secret")
    const snapshots: string[] = []
    session.subscribe((snapshot) => {
      snapshots.push(snapshot.status)
    })
    expect(session.currentSnapshot().status).toBe("failed")
    const receipt = session.dispose()
    const secondReceipt = session.dispose()
    await Promise.all([receipt, secondReceipt])
    const count = snapshots.length
    session.decline()
    session.markSaved(0)
    session.markAllSaved()
    session.subscribe((snapshot) => {
      snapshots.push(snapshot.status)
    })
    expect(snapshots).toHaveLength(count)
  })

  it("does not create a connection when direct settings resolve after disposal", async () => {
    const entered = Promise.withResolvers<undefined>()
    const direct = Promise.withResolvers<undefined>()
    boundary.direct.mockImplementation(async () => {
      entered.resolve(undefined)

      await direct.promise
    })
    boundary.connect.mockClear()
    const session = createRecipientSession("room", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    await entered.promise
    await session.dispose()
    direct.resolve(undefined)
    await direct.promise
    await Promise.resolve()
    expect(boundary.connect).not.toHaveBeenCalled()
  })
})
