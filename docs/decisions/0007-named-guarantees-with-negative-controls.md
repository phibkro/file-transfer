# 0007 Named guarantees with negative controls

Status: accepted (2026-10-28)

## Context

ADR 0003 makes conformance suites the proof that every platform layer behaves like the reference layer. A suite proves only what its checks can detect, and a check that cannot fail proves nothing. The first suites were lists of tests with no stated contract and no evidence that any test could fail.

Adapted from the store-capability contract suites of phibkro/vektorprogrammet-reimagined (its ADR 0014), same author.

## Decision

- Each service declares its guarantees as data next to its tag: `declareGuarantees([{ identifier, property, strength }])`, from `@file-transfer/conformance/guarantee`. Identifiers are `service/short-name`; strength is `store-enforced` (the storage engine makes violation impossible) or `port-enforced` (the layer's code upholds it).
- The suite is `conformanceSuite({ service, guarantees, checks })` with exactly one check per guarantee; the type system rejects a missing or extra check.
- Every layer registers `suite.run(name, layer)` and `suite.negativeControls(name, variants)`: for each guarantee, a broken variant whose check must reject it. A suite without a variant for every guarantee fails.
- A check that crashes (TypeError, ReferenceError, SyntaxError anywhere in the cause chain) does not count as a rejection, so a typo cannot pass as a negative control.
- Reference layers take `faults: ReadonlySet<Guarantee>` to build their broken variants. Platform layers build theirs however suits the runtime (a flag, a wrapper, a misconfigured binding).
- Pure helpers (entitlements, size buckets, `stripFragment`) are tested directly, outside the suite; the suite is only for what a layer must uphold.
- Reference layers require capabilities (`Clock`, `Crypto`) instead of reaching for globals, so each platform supplies its runtime's, and tests supply `secureCrypto` and `TestClock`.

## Consequences

- The guarantee list is the readable contract of each service, and a platform layer cannot be marked complete without a broken twin per guarantee.
- Port-enforced guarantees are only as strong as the port's view: `abuse/fragment-never-stored` checks the receipt, not what a platform writes to disk. Platform suites must add a storage-level check where the runtime allows one.
- `effect/Crypto` is marked unstable in Effect 4. We adopt it because Effect's platform packages implement it; `unstableApiUsage` is off in `tsconfig.json` for that reason, so an Effect upgrade that changes `Crypto` shows up as a type error rather than as lint noise.
