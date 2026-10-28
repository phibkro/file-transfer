/**
 * Conformance suites (docs/decisions/0007). Test support only: never imported by shipped code. The guarantee
 * vocabulary that services declare with is in `./guarantee.ts`.
 *
 * Every layer that implements a service (the reference layer, each platform layer) must pass the check of every
 * guarantee, and must also supply, for each guarantee, a broken variant that the check rejects. A check that cannot
 * fail proves nothing, so a suite without a negative control for every guarantee fails too.
 *
 * Adapted from the store-capability contract suites of phibkro/vektorprogrammet-reimagined (that repository's
 * ADR 0014), same author.
 */
import { describe, expect, it } from "vite-plus/test"
import { Crypto, Effect, Layer } from "effect"
import type { Guarantee } from "./guarantee.ts"

export type { Guarantee, Strength } from "./guarantee.ts"

/**
 * The Web Crypto API as Effect's `Crypto` capability, for tests. Reference layers require `Crypto` rather than reaching
 * for the global, so each platform supplies its own from its runtime; tests supply this one.
 */
export const secureCrypto: Layer.Layer<Crypto.Crypto> = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.map(
        Effect.promise(async () => await globalThis.crypto.subtle.digest(algorithm, new Uint8Array(data))),
        (buffer) => new Uint8Array(buffer),
      ),
  }),
)

/** A check runs a property against a layer and rejects when the property does not hold. */
export type Check<Service> = (layer: Layer.Layer<Service>) => Promise<void>

export interface BrokenVariant<Service, Identifier extends string> {
  readonly violates: Identifier
  readonly layer: Layer.Layer<Service>
}

export interface ConformanceSuite<Service, Identifier extends string> {
  /** Registers one test per guarantee against `layer`. */
  readonly run: (layerName: string, layer: Layer.Layer<Service>) => void
  /** Registers one test per broken variant (its check must reject) and one that every guarantee has a variant. */
  readonly negativeControls: (layerName: string, variants: readonly BrokenVariant<Service, Identifier>[]) => void
}

/**
 * A check that crashes (a TypeError from a typo, say) has not shown that the variant breaks the guarantee, so it does
 * not count as a rejection. Walks the cause chain, since property-test runners wrap the original error.
 */
const isProgrammingError = (cause: unknown): boolean => {
  for (let current = cause, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth++) {
    if (current instanceof TypeError || current instanceof ReferenceError || current instanceof SyntaxError) {
      return true
    }
  }

  return false
}

export const conformanceSuite = <Service, Identifier extends string>(definition: {
  readonly service: string
  readonly guarantees: readonly Guarantee<Identifier>[]
  readonly checks: { readonly [Key in Identifier]: Check<Service> }
}): ConformanceSuite<Service, Identifier> => ({
  run: (layerName, layer) => {
    describe(`${definition.service} conformance: ${layerName}`, () => {
      for (const guarantee of definition.guarantees) {
        it(`${guarantee.identifier}: ${guarantee.property}`, async () => {
          await definition.checks[guarantee.identifier](layer)
        })
      }
    })
  },
  negativeControls: (layerName, variants) => {
    describe(`${definition.service} negative controls: ${layerName}`, () => {
      for (const variant of variants) {
        it(`a variant that breaks ${variant.violates} fails its check`, async () => {
          let outcome: "passed" | "rejected" | "crashed" = "passed"

          try {
            await definition.checks[variant.violates](variant.layer)
          } catch (error) {
            outcome = isProgrammingError(error) ? "crashed" : "rejected"
          }

          expect(outcome).toBe("rejected")
        })
      }

      it("every guarantee has a negative control", () => {
        const controlled = new Set(variants.map((variant) => variant.violates))
        const missing = definition.guarantees.filter((guarantee) => !controlled.has(guarantee.identifier)).map((guarantee) => guarantee.identifier)
        expect(missing).toEqual([])
      })
    })
  },
})
