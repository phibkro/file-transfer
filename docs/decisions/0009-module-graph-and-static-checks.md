# 0009 Module graph and static checks

Status: accepted (2026-10-28). Amended by 0010: `vp check` replaces `typecheck`, `vp test` replaces `bun test`. Amended 2026-10-30: knip owns unused and unlisted packages (spike 0007), and ox-dep-lint replaces the hand-written `check:graph`.

## Context

The package-kind table in CLAUDE.md (ADR 0003) and the Effect conventions were enforced by review only. A kind rule broken once (a service importing a vendor SDK, a library reaching into a service) is hard to undo later.

Adapted from the module-layer check of phibkro/vektorprogrammet-reimagined (its ADR 0015), same author.

## Decision

`bun run check` runs, in order:

1. `typecheck`: TypeScript 7 (`tsc`), strict.
2. `check:graph`: [ox-dep-lint](https://github.com/phibkro/ox-dep-lint) (MIT, same author), configured in `ox-dep-lint.config.ts`. It replaced the hand-written check of `tools/quality` once its rules, and the gaps its reviews found, were covered by negative controls (the spike's proposal). The configuration is the package-kind table of CLAUDE.md: which kinds may depend on which, which outside packages each kind may use, no runtime modules (`node:*`, a bare Node built-in, `bun`, `bun:*`, `cloudflare:*`) in shipped library or service code, test-only imports only in tests or the conformance suite's entry, relative imports that stay inside their package, every import declared (shipped code in `dependencies`), no computed `import()` in shipped code, and no package cycles. Type-only imports are judged like value imports (`imports.typeOnly: "as-values"`, ox-dep-lint 0.2), as the hand-written check did, so a service's or library's public types cannot name a runtime or a vendor package either. It reads every form that loads a module (re-exports, `import()`, type-level imports, `require`), resolves them with oxc-resolver, and checks `package.json` edges in every dependency field. The same configuration loads its oxlint plugin in `vite.config.ts`, so the editor and `vp check` report the per-file findings where they are written; the CLI adds the whole-graph checks.
3. `check:dependencies`: knip (`knip.jsonc`), limited to dependency hygiene: declared packages nothing uses (devDependencies and the root included), packages imported but not declared, imports that resolve to nothing, and binaries scripts call but nothing installs. It replaced `check:graph`'s unused-dependency rule (spike 0007, `docs/spikes/0007-dependency-graph-tools.md`). `--treat-config-hints-as-errors` fails it when an ignored dependency or binary, an entry or a workspace in `knip.jsonc` stops being needed (a stale file `ignore` pattern does not). The two effect-tsgo ignores are global, so a stray declaration of `@effect/tsgo` or `@effect/language-service` in a package still passes. It does not replace `check:graph`'s undeclared-import rule: knip sees only files reachable from an entry, and it lets shipped code import a root devDependency.
4. `lint`: `effx check`, the coordinator of `@phibkro/oxlint-effect-plugin`. It runs the plugin's oxlint rules, audits reasoned escapes, gates the import closure, and includes the type-aware Effect diagnostics of effect-tsgo (enabled through the `@effect/language-service` plugin entry in `tsconfig.json`); any diagnostic fails it. Roles and platforms per file group live in `effx.config.json`, which `oxlint.config.ts` also reads. Groups must be disjoint (they compile to overrides that merge rule by rule) and must not use brace globs (the coordinator does not expand them). Workspace packages are admitted to the import closure by exact specifier with a reason, because Bun links them through `node_modules`; the kind-level edge is `check:graph`'s job.
5. `test`: `bun test`.

File-level import cycles are oxlint's `import/no-cycle`, which Ultracite's core preset already turns on in `vp check`.

`bun run check:effect` prints the effect-tsgo diagnostics on their own, for reading; `check` does not repeat them.

`gitleaks` scans history and the tree in CI (`.github/workflows/checks.yml`) and locally with `bun run check:secrets` when the binary is installed.

The `effx` coordinator pins reviewed versions (oxlint 1.86.0, TypeScript 7.0.2, @effect/tsgo 0.48.0); upgrades follow the plugin's compatibility file.

`libraries/parcel` opts out of the Effect lint with a reasoned file-level escape: it is the MIT parcel core, deliberately free of Effect so other clients can adopt it, with Web Crypto as its one capability.

## Consequences

- A forbidden edge fails the check before review. The first run found an unused `effect` dependency in `libraries/client`.
- `tools/*` is a new package kind: repository checks and generators, which may import any kind and which no other kind may import.
- TypeScript 7 has no JavaScript compiler API, so tools parse with `oxc-parser`.
