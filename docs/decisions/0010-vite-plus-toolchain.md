# 0010 Vite+ as the toolchain

Status: accepted (2026-10-28). Amends 0009.

## Context

`bun run check` chained separate tools: `tsc` for types, oxlint through `effx` for the Effect profile, `bun test` for tests, and no formatter. `apps/web` will need Vite in any case. Vite+ (VoidZero, MIT, now at 1.4) bundles Vite 8, Vitest 5, Oxlint, Oxfmt, Rolldown, tsdown and a cached task runner behind one `vp` command, and wraps Bun as the package manager. VoidZero joined Cloudflare in June 2026, our first platform's vendor.

Measured in a trial on this repository with vite-plus 1.4.0: `vp check` (format, lint, type check through tsgolint) took about 1.3 s and caught a planted type error; all 70 tests passed under Vitest 5 on Node 22 with only the test import changed; `vp lint` loads the Effect plugin as a JS plugin but does not apply `effx`'s reasoned escapes.

## Decision

- `vite-plus` 1.4.0, pinned, with one root `vite.config.ts` (`fmt`, `lint`, `test`).
- `vp check` formats (Oxfmt), lints (Oxlint core rules, type-aware) and type checks; it replaces `tsc --noEmit`.
- `vp test` (Vitest) replaces `bun test`. Tests and the conformance harness import from `vite-plus/test`.
- `effx check` stays the authority for the Effect profile, its escapes and its import closure; the Effect rules are not repeated in `vite.config.ts`. `effx` keeps its own pinned oxlint (1.86.0) next to the one Vite+ bundles.
- Bun stays the package manager and runs the repository tools (`check:graph`).
- `bun run check` is `vp check`, `check:graph`, `check:effect` (`effx check`), `vp test run`.

## Alternatives

- Void (VoidZero, open-sourced by Cloudflare on 2026-10-15) deploys Vite apps to Workers and infers D1, KV, R2, queues and AI bindings from imports. None of the sources reviewed document Durable Objects or WebSockets, which rooms and relays need, and its self-hosted Node target drops real-time connections. Not adopted; infrastructure is a separate decision, with Alchemy (Effect-based, explicit resources, Durable Objects supported) as the leading candidate.

## Consequences

- One formatter for code and docs; the first run reformatted 41 files.
- Tests run on Node instead of Bun. Neither is the Workers runtime, so platform suites will need Cloudflare's Vitest integration or workerd; whether that integration supports Vitest 5 is unchecked.
- Two oxlint versions until the Effect plugin reviews the one Vite+ bundles.
