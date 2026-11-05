import { Effect, Result, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vite-plus/test"
import { Catalog, decide, LibrarySnapshot } from "../src/index.ts"
import type { CatalogError, CatalogPlan } from "../src/index.ts"
import { catalogScenarios } from "./scenarios.ts"

const empty: LibrarySnapshot = { enabled: true, epoch: 1, files: [], collections: [] }
const original = { name: "file", size: 1, lastModified: 1, fingerprint: "first" }

describe("portable Catalog", () => {
  for (const scenario of catalogScenarios) {
    it(scenario.name, async () => {
      await Effect.runPromise(scenario.run.pipe(Effect.provide(Catalog.layer)))
    })
  }

  it("does not change consent when a mutation is only constructed", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* Catalog
        const before = yield* catalog.read
        const discarded = catalog.mutate({ type: "configure", enabled: true, epoch: before.epoch })
        expectTypeOf(discarded).toEqualTypeOf<Effect.Effect<LibrarySnapshot, CatalogError>>()
        expect(yield* catalog.read).toEqual(before)
      }).pipe(Effect.provide(Catalog.layer)),
    )
  })

  it("states exact public result and service channels", () => {
    expectTypeOf(decide(empty, { type: "index", incoming: [], epoch: 1 })).toEqualTypeOf<Result.Result<CatalogPlan, CatalogError>>()

    const program = Effect.gen(function* () {
      return yield* (yield* Catalog).read
    })

    expectTypeOf(program).toEqualTypeOf<Effect.Effect<LibrarySnapshot, CatalogError, Catalog>>()
  })

  it("decodes portable metadata and rejects malformed storage rows", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeEffect(LibrarySnapshot)(empty)
        expect(decoded).toEqual(empty)

        const malformed = yield* Effect.result(
          Schema.decodeEffect(LibrarySnapshot)({ ...empty, files: [{ ...original, identifier: 1, revision: 0, size: Number.POSITIVE_INFINITY }] }),
        )

        expect(Result.isFailure(malformed)).toBe(true)
      }),
    )
  })
})
