import { Effect, Option, Redacted } from "effect"
import { Mount } from "foldkit"
import * as Scene from "foldkit/scene"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { ChartMount } from "../src/admin/chart.ts"
import { fetchCounters, fetchInstance, lastHours, readStoredToken, storeToken } from "../src/admin/data.ts"
import { init, Message, update, view } from "../src/admin/main.ts"

const snapshot = {
  byKind: { "room-created": 3, "recipient-joined": 2, "transfer-completed": 1, "transfer-failed": 1, "path-direct": 1, "path-relayed": 1 },
  bySizeBucket: { "under-10-megabytes": 2, "under-1-gigabyte": 0, "under-10-gigabytes": 0, "10-gigabytes-or-more": 0 },
  relayedMegabytes: 4,
}

const counts = { counters: true as const, kinds: { "room-created": "rooms created" }, total: snapshot, hours: [{ hour: 100, snapshot }] }

afterEach(() => vi.unstubAllGlobals())

describe("operator data boundary", () => {
  it("defers requests and sends the token only to the fixed counters path", async () => {
    const fetch = vi.fn(async () => Response.json(counts))
    vi.stubGlobal("fetch", fetch)
    const token = Redacted.make("test-admin-secret")
    const pending = fetchCounters(token)
    expect(fetch).not.toHaveBeenCalled()
    expect(await Effect.runPromise(pending)).toEqual({ status: 200, body: counts })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/counters?hours=48",
      expect.objectContaining({
        cache: "no-store",
        headers: { authorization: "Bearer test-admin-secret" },
      }),
    )
    expect(JSON.stringify(token)).not.toContain("test-admin-secret")
  })

  it("decodes instance data without an authorization header", async () => {
    const instance = { limits: { roomsPerAddressPerHour: 10, relayedBytesPerRoom: 100, relayedBytesPerDay: null }, counters: true }
    const fetch = vi.fn(async () => Response.json(instance))
    vi.stubGlobal("fetch", fetch)
    expect(await Effect.runPromise(fetchInstance)).toEqual({ status: 200, body: instance })
    expect(fetch).toHaveBeenCalledWith("/api/instance", expect.objectContaining({ headers: {} }))
  })

  it("preserves unauthorized status and rejects malformed counter data", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ...counts, total: { ...snapshot, relayedMegabytes: -1 } }))

    vi.stubGlobal("fetch", fetch)
    const token = Redacted.make("bad-token")
    expect(await Effect.runPromise(fetchCounters(token))).toEqual({ status: 401, body: undefined })
    expect(await Effect.runPromise(fetchCounters(token))).toEqual({ status: 200, body: undefined })
  })

  it("does not expose credentials in network errors", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("test-admin-secret")
    })
    const error = await Effect.runPromise(Effect.flip(fetchCounters(Redacted.make("test-admin-secret"))))
    expect(error._tag).toBe("AdminDataError")
    expect(JSON.stringify(error)).not.toContain("test-admin-secret")
    expect(String(error)).not.toContain("test-admin-secret")
  })

  it("stores and forgets the token, and tolerates unavailable storage", async () => {
    const values = new Map<string, string>()
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
    })
    const token = Redacted.make("test-admin-secret")
    const pending = storeToken(token)
    expect(values.size).toBe(0)
    await Effect.runPromise(pending)
    expect(Redacted.value(await Effect.runPromise(readStoredToken))).toBe("test-admin-secret")
    await Effect.runPromise(storeToken(undefined))
    expect(Redacted.value(await Effect.runPromise(readStoredToken))).toBe("")
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
      removeItem: () => {
        throw new Error("blocked")
      },
    })
    expect(Redacted.value(await Effect.runPromise(readStoredToken))).toBe("")
    await Effect.runPromise(storeToken(token))
    await Effect.runPromise(storeToken(undefined))
  })

  it("fills exactly 48 buckets ending at the supplied hour", () => {
    const rows = lastHours(
      [
        { hour: 100, snapshot },
        { hour: 51, snapshot },
      ],
      101 * 3_600_000 + 42,
    )

    expect(rows).toHaveLength(48)
    expect(rows[0]).toEqual({ hour: 54, snapshot: undefined })
    expect(rows[46]).toEqual({ hour: 100, snapshot })
    expect(rows[47]).toEqual({ hour: 101, snapshot: undefined })
  })
})

describe("operator model", () => {
  it("executes the queued forget after the save and leaves storage empty", async () => {
    const values = new Map<string, string>()
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
    })
    const token = Redacted.make("secret")
    const changed = update(init().model, Message.ChangedToken({ token })).model
    const requested = update(changed, Message.RequestedCounts()).model
    const saved = update(requested, Message.ReceivedCounts({ request: requested.request, status: 200, result: Redacted.make(counts), rows: Redacted.make([]) }))
    const forgotten = update(saved.model, Message.RequestedForget())
    const save = saved.commands?.[0]
    expect(save).toBeDefined()

    if (save === undefined) {
      throw new Error("missing save command")
    }

    expect(save.args).toEqual({ token: Option.some(token), sequence: saved.model.storageSequence })
    expect(values.size).toBe(0)
    const savedMessage = await Effect.runPromise(save.effect)
    expect(Redacted.value(await Effect.runPromise(readStoredToken))).toBe("secret")
    const flushed = update(forgotten.model, savedMessage)
    const forget = flushed.commands?.[0]
    expect(forget).toBeDefined()

    if (forget === undefined) {
      throw new Error("missing forget command")
    }

    expect(forget.args).toEqual({ token: Option.none(), sequence: forgotten.model.storageSequence })
    const forgottenMessage = await Effect.runPromise(forget.effect)
    expect(Redacted.value(await Effect.runPromise(readStoredToken))).toBe("")
    expect(Option.isNone(update(flushed.model, forgottenMessage).model.storageActive)).toBe(true)
  })

  it("serializes a pending forget behind an in-flight save and ignores old completions", () => {
    const changed = update(init().model, Message.ChangedToken({ token: Redacted.make("secret") })).model
    const requested = update(changed, Message.RequestedCounts()).model
    const saved = update(requested, Message.ReceivedCounts({ request: requested.request, status: 200, result: Redacted.make(counts), rows: Redacted.make([]) }))
    expect(saved.commands).toHaveLength(1)
    const forgotten = update(saved.model, Message.RequestedForget())
    expect(forgotten.commands).toBeUndefined()
    expect(forgotten.model.storagePending).toEqual(Option.some({ token: Option.none(), sequence: forgotten.model.storageSequence }))
    const flushed = update(forgotten.model, Message.CompletedStorage({ sequence: saved.model.storageSequence }))
    expect(flushed.commands).toHaveLength(1)
    expect(flushed.model.storageActive).toEqual(Option.some(forgotten.model.storageSequence))
    expect(update(flushed.model, Message.CompletedStorage({ sequence: saved.model.storageSequence })).model).toEqual(flushed.model)
    const complete = update(flushed.model, Message.CompletedStorage({ sequence: forgotten.model.storageSequence }))
    expect(Option.isNone(complete.model.storageActive)).toBe(true)
  })

  it("keeps only the newest pending storage intent", () => {
    const first = update(init().model, Message.RequestedForget())
    const changed = update(first.model, Message.ChangedToken({ token: Redacted.make("new") })).model
    const requested = update(changed, Message.RequestedCounts()).model
    const saved = update(requested, Message.ReceivedCounts({ request: requested.request, status: 200, result: Redacted.make(counts), rows: Redacted.make([]) }))
    expect(saved.model.storagePending).toEqual(Option.some({ token: Option.some(Redacted.make("new")), sequence: saved.model.storageSequence }))
    const forgotten = update(saved.model, Message.RequestedForget())
    expect(forgotten.model.storagePending).toEqual(Option.some({ token: Option.none(), sequence: forgotten.model.storageSequence }))
    const flushed = update(forgotten.model, Message.CompletedStorage({ sequence: first.model.storageSequence }))
    expect(flushed.commands).toHaveLength(1)
    expect(flushed.model.storageActive).toEqual(Option.some(forgotten.model.storageSequence))
    expect(Option.isNone(flushed.model.storagePending)).toBe(true)
  })

  it("ignores a response from before forgetting the token", () => {
    const changed = update(init().model, Message.ChangedToken({ token: Redacted.make("secret") })).model
    const requested = update(changed, Message.RequestedCounts()).model
    const forgotten = update(requested, Message.RequestedForget()).model

    const stale = update(
      forgotten,
      Message.ReceivedCounts({ request: requested.request, status: 200, result: Redacted.make(counts), rows: Redacted.make([]) }),
    ).model

    expect(stale).toEqual(forgotten)
    expect(Redacted.value(stale.token)).toBe("")
    expect(Option.isNone(stale.counts)).toBe(true)
  })

  it("distinguishes a rejected token from decoded counts", () => {
    const changed = update(init().model, Message.ChangedToken({ token: Redacted.make("secret") })).model
    const requested = update(changed, Message.RequestedCounts()).model

    const denied = update(
      requested,
      Message.ReceivedCounts({ request: requested.request, status: 401, result: Redacted.make(undefined), rows: Redacted.make([]) }),
    )

    expect(denied.model.status).toContain("not this instance")
    expect(denied.commands).toHaveLength(1)

    const accepted = update(
      requested,
      Message.ReceivedCounts({ request: requested.request, status: 200, result: Redacted.make(counts), rows: Redacted.make([]) }),
    )

    expect(Option.isSome(accepted.model.counts)).toBe(true)
    expect(accepted.model.status).toBe("")
  })
})

describe("operator completion view", () => {
  it.each([
    [0, 0, "no transfers have ended yet"],
    [Number.MAX_SAFE_INTEGER, 1, "unavailable (invalid counts)"],
  ])("omits the meter when completion is undefined or invalid", (completed, failed, description) => {
    const total = { ...snapshot, byKind: { ...snapshot.byKind, "transfer-completed": completed, "transfer-failed": failed } }
    const model = { ...init().model, counts: Option.some(Redacted.make({ ...counts, total })) }

    Scene.scene(
      { update, view },
      Scene.given(model),
      Scene.expect(Scene.text(description)).toExist(),
      Scene.expect(Scene.role("meter")).toBeAbsent(),
      Scene.Mount.resolve(
        Mount.mapMessage(ChartMount({ rows: Redacted.make([]) }), ({ success }) => Message.CompletedChart({ success })),
        Message.CompletedChart({ success: true }),
      ),
    )
  })
})
