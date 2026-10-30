# Spike 0007: adopt existing dependency-graph tools, or extract our own

Input for a decision on `tools/quality`'s module graph check (docs/decisions/0009). Three repositories by the same author carry their own copy of this check (this one, phibkro/vektorprogrammet-reimagined, reebeat/reebeat), and they drift: computed `import()` was handled in reebeat long before #29 added it here. Before extracting one shared package (working name `dep-lint`), this spike asks which parts existing tools already do. Run on 2026-10-30 against `main` at e5ee199 in a separate worktree, Bun 1.4.4, oxlint 1.86.0, Vite+ 1.4.0.

## Method

Each tool ran with the smallest configuration that matches this repository, then against planted violations, one at a time, next to `bun run check:graph`. Plants were removed after each run. Timings are wall clock on a shared two-core machine, second of two runs.

## What each tool caught

| Planted violation                                                  | `check:graph` | knip 6.44 | oxlint `import/no-cycle` | oxlint-plugin-boundaries 0.1.0 |
| ------------------------------------------------------------------ | ------------- | --------- | ------------------------ | ------------------------------ |
| Undeclared import (`valibot` in `libraries/sink`)                  | yes           | yes       | n/a                      | n/a                            |
| Declared, never imported (`@file-transfer/machine` in sink)        | yes           | yes       | n/a                      | n/a                            |
| Forbidden kind edge (service `room` imports `platform-cloudflare`) | yes           | no        | n/a                      | did not load (below)           |
| Cycle between two files of one package                             | no            | no        | yes, both files          | n/a                            |

- **knip** needs entry points for files run as scripts (`tools/quality/src/check*.ts`, `apps/web/scripts/**`, `alchemy.run.ts`) and to ignore `cloudflare:workers`; without them it reports 17 unused files and 11 unlisted `cloudflare` imports, all false. Configured (`knip.json` with five workspace entries), dependency checks only, it reports four items worth a look: the root `effect` dependency, `@effect/tsgo` (used only through configuration), `workerd` in `platforms/cloudflare`, and `ws` in `spikes/0003`. vektorprogrammet-reimagined and reebeat already run knip.
- **oxlint `import/no-cycle`** builds a project-wide module graph natively (oxlint's multi-file analysis) and found the planted file cycle in about 1 s over the whole repository. `check:graph` checks cycles between packages only.
- **oxlint-plugin-boundaries** classifies by path with a `package.json` name index and an allow-matrix, the same model as `check:graph`'s kind table. Under oxlint 1.86.0 its `jsPlugins` entry was read without error but the plugin's rules never registered (98 default rules, no diagnostics, exit 0) in three attempts: package name, `.oxlintrc.json` name, explicit path. Unproven here, not refuted; oxlint's JS plugins are alpha.
- **import-integrity-lint** (1.3.1) was not run: ESLint-first, with `@typescript-eslint` and `zod` dependencies, and aimed at dead exports and broken imports rather than kind rules.

## Timings

| Command                                             | Time               |
| --------------------------------------------------- | ------------------ |
| `bun run check:graph`                               | 0.34 s             |
| `knip --include dependencies,unlisted`              | 1.6 s              |
| oxlint with only `import/no-cycle`, whole repo      | 1.0 s              |
| `vp run --cache check:graph`, first run, then a hit | 1.7 s, then 0.09 s |

`vp run --cache` works in this Bun workspace: a changed input (`libraries/sink/src/index.ts`) made it miss ("'libraries/sink/src/index.ts' modified, executing"), and reverting the file made it hit again. Its documentation lists only pnpm, npm and Yarn.

## Findings

1. **knip replaces two of `check:graph`'s rules**, undeclared and unused dependencies, and checks more (unused files and exports, unlisted binaries) once its entry points are declared. Keeping our own copies of those rules is duplicate work.
2. **oxlint's native `import/no-cycle` covers what `check:graph` does not**: cycles inside a package, on a real module graph, already in the toolchain (`vp check` runs oxlint).
3. **What no adopted tool does here** is the kind table: which kinds may depend on which, which outside packages each kind may use, no runtime modules or test-only specifiers in shipped code, relative imports that stay inside the package, computed `import()`. That, plus vektorprogrammet-reimagined's layers inside a package with a shrink-only baseline, is the part worth owning.
4. **The rule table is small; the scanner is where the copies drift.** A shared package should own the scanner (oxc-parser, and oxc-resolver so edges are resolved files, not guessed package names) and take each repository's table as data.
5. **An oxlint plugin can only be a per-file front end.** Oxlint gives its module graph to built-in rules only; a JS plugin would resolve imports itself. Until a JS plugin loads reliably in the oxlint version Vite+ ships, the command-line check stays primary.

## Proposal

- Adopt knip for undeclared and unused dependencies, and enable `import/no-cycle` in the oxlint configuration; drop the matching rules from `check:graph` once both run in `bun run check`.
- Extract the kind table and scanner as `dep-lint` (core: oxc-parser, oxc-resolver, rule table as data; command line first; an `oxlint-plugin-dep-lint` front end for editor feedback once JS plugins load), and move this repository, vektorprogrammet-reimagined and reebeat onto it. A decision record precedes the extraction.
- Re-check dependency-cruiser once TypeScript 7.1 ships (its stable release supports `typescript <7`, issue sverweij/dependency-cruiser#1112) and oxlint-plugin-boundaries once oxlint's JS plugins load in the pinned version.

## Sources

- knip issue types: https://knip.dev/reference/issue-types
- oxlint multi-file analysis: https://oxc.rs/docs/guide/usage/linter/multi-file-analysis
- oxlint JS plugins (alpha): https://oxc.rs/docs/guide/usage/linter/js-plugins
- oxlint-plugin-boundaries: https://registry.npmjs.org/oxlint-plugin-boundaries
- import-integrity-lint: https://registry.npmjs.org/import-integrity-lint
- dependency-cruiser and TypeScript 7: https://github.com/sverweij/dependency-cruiser/issues/1112
- Vite+ cache: https://viteplus.dev/guide/cache
