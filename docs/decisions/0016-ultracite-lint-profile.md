# 0016 Ultracite core and anti-slop as the lint profile

Status: accepted (2026-10-28), at the product owner's request.

## Context

`vp check` ran oxlint's default rules, and warnings did not fail it. The product owner asked for Ultracite (8.1.0) with its anti-slop rules, effect-tsgo diagnostics and every warning failing the check.

Two facts shaped the adoption:

- `vp check` reads only the `lint` block of `vite.config.ts`, not `oxlint.config.ts` (which `effx check` uses for the Effect profile). The Ultracite presets therefore go in that block, and `bun run check` runs `vp check --deny-warnings`. A throwaway file with an `unknown` parameter makes `bun run check` exit 1.
- Applied as-is, the presets reported 6,907 findings, and their autofix broke 12 parcel tests: `sort-keys` reordered `{ name, size, mediaType }`, which changes the canonical manifest bytes of the frozen parcel v1 format.

## Decision

`vite.config.ts` extends `ultracite/oxlint/core` and `ultracite/oxlint/anti-slop`. The generated Unicode table (`libraries/parcel/src/unicode.ts`) is ignored. Rules that conflict with this codebase on purpose are turned off with a one-line reason next to each:

| Rule                                                  | Why it is off                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `eslint/sort-keys`                                    | Object key order is meaningful: the canonical manifest JSON is written in declaration order                       |
| `eslint/no-bitwise`                                   | Byte, hash and record code is bitwise by nature                                                                   |
| `eslint/no-await-in-loop`                             | Records are read, sealed and sent one after another on purpose                                                    |
| `eslint/func-names`                                   | `Effect.gen` takes anonymous `function*` bodies                                                                   |
| `eslint/no-plusplus`                                  | Index loops over bytes and records                                                                                |
| `unicorn/prefer-spread`                               | Its fix turns `Uint8Array` copies into number arrays                                                              |
| `unicorn/no-useless-undefined`                        | Its fix deleted `undefined` arguments TypeScript requires                                                         |
| `unicorn/filename-case`                               | Repository file names are camelCase                                                                               |
| `promise/avoid-new`                                   | Wrapping event APIs needs the Promise constructor                                                                 |
| `node/callback-return`                                | Misreads the machine library's `next`                                                                             |
| `eslint/complexity`                                   | Protocol dispatchers are flat switches over message types                                                         |
| `eslint/default-case`, `typescript/consistent-return` | `switch-exhaustiveness-check` and TypeScript's return checks cover these, and a default would hide a missing case |
| `eslint/max-classes-per-file`                         | A service's tagged errors live next to it                                                                         |
| `unicorn/no-array-method-this-argument`               | Misreads `Effect.forEach(iterable, f)`                                                                            |
| `eslint/no-redeclare`                                 | An Effect Schema value and its type share one name                                                                |
| `unicorn/prefer-code-point`                           | Byte-level code: Latin-1 and hex strings are UTF-16 code units by design                                          |
| `eslint/require-await`                                | `promise-function-async` makes functions that meet an async contract without awaiting async                       |
| `typescript/no-unsafe-type-assertion`                 | anti-slop's rule governs assertions instead: each one states its checked invariant in a `SAFETY:` comment         |
| `eslint/no-use-before-define`                         | TypeScript already rejects use before declaration (TS2448); what remains are closures that run later              |
| `eslint/no-unmodified-loop-condition`                 | Async loops wait on state that event handlers change                                                              |
| `unicorn/prefer-structured-clone`                     | A JSON round trip compares JSON forms, which `structuredClone` does not produce                                   |

Two rules are tuned rather than turned off: `prefer-destructuring` applies to declarations only, and `no-void` allows `void promise` as a statement (a deliberate fire-and-forget). Narrow overrides: `promise-function-async` is off for files `effx` governs as Effect code (taken from `effx.config.json`, since effx forbids native async there); the manifest validator and the room's request decoder, which are the parse-at-the-boundary code anti-slop asks for, may take `unknown` and use `typeof`; `workers.d.ts` keeps Cloudflare's declaration style.

`effx check` already failed on every effect-tsgo severity, suggestions included, so nothing changed there.

## Consequences

- Every remaining type assertion carries a `SAFETY:` comment; error parameters are named `cause`; untrusted input is decoded at its boundary (the integration check decodes room messages with `decodeControlMessage`).
- The parcel changed only in behaviour-preserving ways, and the test vectors and property tests are unchanged and pass.
- An autofix can change bytes on the wire, so autofixes in `libraries/parcel` are applied rule by rule with the vectors as the guard, never `--fix` across the whole tree.
