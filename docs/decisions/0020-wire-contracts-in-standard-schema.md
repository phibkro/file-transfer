# 0020 Wire contracts in Standard Schema, defined with Valibot

Status: accepted (2026-10-29). Amends the package-kind table in CLAUDE.md: libraries may import `valibot` as well as `effect`.

## Context

The product owner asked to cut the browser's JavaScript, and every runtime, to the minimum: the code the browser runs is what users must trust (the security page's main caveat), and recipients often open links on phones on mobile data. Measured on the production build of 2026-10-29, the app was 158.9 KB of JavaScript (57.4 KB compressed). Effect made up about 76 KB of it, almost all Effect Schema, pulled in for one job: validating the room's JSON control messages (`libraries/transport/src/protocol.ts`).

The product owner proposed Standard Schema (standardschema.dev) as the bridge between frontend and backend. Standard Schema is an interface (a `~standard` property with `validate`), not a converter: an Effect schema exported with `Schema.toStandardSchemaV1` is still an Effect schema and still brings Effect along. So the contract itself has to be defined in a library light enough for the browser.

Options compared:

- **Valibot 1.5.0** (MIT): the whole control-message contract bundles to 7.9 KB (2.5 KB compressed), measured with esbuild. No `eval` or `new Function`, so the strict content security policy holds. Its schemas are Standard Schemas.
- **A hand-written decoder**: perhaps 1 KB compressed less, but our own validation code in the trusted base, with its own edge cases. Fuzzing the Valibot decoder against the old Effect decoder found one such edge case on the first run (below), which is the bug class a hand-written decoder would have to rediscover.
- **typia 15.2.1** (validators generated ahead of time from types): it supports TypeScript 7 only through ttsc, a separate Go-based compiler toolchain by typia's author that builds a Go plugin with a bundled Go toolchain and compiles the whole project outside Vite. TypeScript 7.0 ships no compiler API, and 7.1 promises a different one. A second compiler in the build, maintained by one person, outweighs a saving of at most 2.5 KB. Revisit if TypeScript 7.1's API brings typia an official integration that runs inside Vite.

## Decision

1. **Wire contracts are defined once, with Valibot, and exposed as Standard Schema.** `ControlMessage` in `libraries/transport/src/protocol.ts` is a Valibot schema; the browser and the room server both decode with it, and Effect code that wants it reads it through `~standard`. One definition, so the two ends cannot drift.
2. **The browser imports the protocol entry only** (`@file-transfer/transport/protocol`), never the package root, which declares the Effect-based `Transport` interface. The web app no longer depends on Effect.
3. **Decoding returns plain data**: `Decoded<T>` is `{ ok: true, value }` or `{ ok: false, reason }`, and never throws. The same holds for the app's own results (`spansFor` in `apps/web/src/files.ts`). Effect code keeps `Data.TaggedError` and `Result`.
4. **Semantics match the previous Effect schema.** Unknown keys are dropped (`object`, not `strictObject`), so newer peers may add fields; integers must be safe integers (`safeInteger`), as Effect's `Int` required. Before the switch, the new decoder was fuzzed against the old Effect decoder on 200,000 generated inputs (valid and invalid messages, arbitrary JSON, arbitrary text). The first run found Valibot's `integer` accepting integers beyond 2^53 that Effect refused; after the change to `safeInteger`, the two agreed on every input.

## Consequences

- The production bundle fell from 158.9 KB to 89.3 KB (57.4 KB to 34.3 KB compressed). The QR encoder now loads only when asked for (10 KB), and the content pages ship no JavaScript (their layout is applied at build time, `apps/web/scripts/layout.ts`).
- The module graph check (`ox-dep-lint.config.ts`, ADR 0009) allows `valibot` in libraries; effx trusts it as pure.
- New wire contracts (operator API, developer API) follow the same rule: Valibot definitions, exposed as Standard Schema, decoded at the boundary.
- If an Effect service needs a contract as an Effect schema, it adapts the Standard Schema rather than defining it a second time.
