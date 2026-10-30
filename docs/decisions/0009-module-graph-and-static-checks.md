# 0009 Module graph and static checks

Status: accepted (2026-10-28). Amended by 0010: `vp check` replaces `typecheck`, `vp test` replaces `bun test`. Amended 2026-10-30: knip owns unused and unlisted packages (spike 0007).

## Context

The package-kind table in CLAUDE.md (ADR 0003) and the Effect conventions were enforced by review only. A kind rule broken once (a service importing a vendor SDK, a library reaching into a service) is hard to undo later.

Adapted from the module-layer check of phibkro/vektorprogrammet-reimagined (its ADR 0015), same author.

## Decision

`bun run check` runs, in order:

1. `typecheck`: TypeScript 7 (`tsc`), strict.
2. `check:graph`: `tools/quality`. Each `package.json` is the package's declaration; its kind comes from its directory. The rules, as data in `tools/quality/src/moduleGraph.ts`: which kinds may depend on which, which outside packages each kind may use, no runtime modules (`node:*`, `bun:*`, `cloudflare:*`) in shipped library or service code, test-only imports (`bun:test`, `fast-check`, `effect/testing`, `@file-transfer/conformance`) only in tests or declared test-support files, relative imports stay inside the package, every import declared (workspace packages included, and a root devDependency only in development-only files), no package cycles. Each rule has a negative control in its test.
3. `lint`: `effx check`, the coordinator of `@phibkro/oxlint-effect-plugin`. It runs the plugin's oxlint rules, audits reasoned escapes, gates the import closure, and includes the type-aware Effect diagnostics of effect-tsgo (enabled through the `@effect/language-service` plugin entry in `tsconfig.json`); any diagnostic fails it. Roles and platforms per file group live in `effx.config.json`, which `oxlint.config.ts` also reads. Groups must be disjoint (they compile to overrides that merge rule by rule) and must not use brace globs (the coordinator does not expand them). Workspace packages are admitted to the import closure by exact specifier with a reason, because Bun links them through `node_modules`; the kind-level edge is `check:graph`'s job.
4. `test`: `bun test`.
5. `check:dependencies`: knip (`knip.jsonc`), limited to dependency hygiene: declared packages nothing uses (devDependencies and the root included), packages imported but not declared, imports that resolve to nothing, and binaries scripts call but nothing installs. It replaced `check:graph`'s unused-dependency rule (spike 0007). It does not replace `check:graph`'s undeclared-import rule: knip sees only files reachable from an entry, and it lets shipped code import a root devDependency.

File-level import cycles are oxlint's `import/no-cycle`, which Ultracite's core preset already turns on in `vp check`.

`bun run check:effect` prints the effect-tsgo diagnostics on their own, for reading; `check` does not repeat them.

`gitleaks` scans history and the tree in CI (`.github/workflows/checks.yml`) and locally with `bun run check:secrets` when the binary is installed.

The `effx` coordinator pins reviewed versions (oxlint 1.86.0, TypeScript 7.0.2, @effect/tsgo 0.48.0); upgrades follow the plugin's compatibility file.

`libraries/parcel` opts out of the Effect lint with a reasoned file-level escape: it is the MIT parcel core, deliberately free of Effect so other clients can adopt it, with Web Crypto as its one capability.

## Consequences

- A forbidden edge fails the check before review. The first run found an unused `effect` dependency in `libraries/client`.
- `tools/*` is a new package kind: repository checks and generators, which may import any kind and which no other kind may import.
- TypeScript 7 has no JavaScript compiler API, so tools parse with `oxc-parser`.
