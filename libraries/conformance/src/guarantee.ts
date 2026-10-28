/**
 * The vocabulary of guarantees (docs/decisions/0007), importable by shipped service code. The test harness that
 * checks guarantees lives in `./index.ts` and is test support only.
 */

/**
 * - `store-enforced`: holds against every writer, because the storage or the single writer behind it enforces it.
 * - `port-enforced`: holds only for callers that go through the service.
 */
export type Strength = "store-enforced" | "port-enforced"

export interface Guarantee<Identifier extends string> {
  readonly identifier: Identifier
  /** The property in words, as a test name and in the generated documentation. */
  readonly property: string
  readonly strength: Strength
}

export const declareGuarantees = <const Identifier extends string>(guarantees: ReadonlyArray<Guarantee<Identifier>>): ReadonlyArray<Guarantee<Identifier>> =>
  guarantees
