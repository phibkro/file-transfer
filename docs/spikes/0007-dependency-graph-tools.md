# Spike 0007: adopt existing dependency-graph tools, or extract our own

Input for a decision on `tools/quality`'s module graph check (docs/decisions/0009). Three repositories by the same author carry their own copy of this check (this one, phibkro/vektorprogrammet-reimagined, reebeat/reebeat), and they drift: computed `import()` was handled in reebeat long before #29 added it here. Before extracting one shared package (working name `dep-lint`), this spike asks which parts existing tools already do. Run on 2026-10-30 against `main` at e5ee199 in a separate worktree, Bun 1.4.4, oxlint 1.86.0 (the repository's pin; Vite+ 1.4.0 itself ships 1.89.0), Vite+ 1.4.0, and corrected after rounds 1 and 2 of its review.

## Method

Each tool ran with the smallest configuration that matches this repository, then against planted violations, one at a time, next to `bun run check:graph`. Plants were removed after each run. The configurations were scratch files: the knip one became `knip.jsonc` (#32), and the plugin's used one element type per kind directory with the kind table as its allow-matrix. Timings are wall clock on a shared two-core machine, second of two runs.

## What each tool caught

| Planted violation                                                                        | `check:graph` | knip 6.44 (spike's `knip.json`) | oxlint `import/no-cycle` | oxlint-plugin-boundaries 0.1.0 |
| ---------------------------------------------------------------------------------------- | ------------- | ------------------------------- | ------------------------ | ------------------------------ |
| Undeclared import of an outside package (`valibot` in `libraries/sink`)                  | yes           | yes                             | n/a                      | n/a                            |
| Undeclared import of a workspace package (`@file-transfer/machine` in sink)              | yes           | no (only with `--strict`)       | n/a                      | n/a                            |
| Shipped code importing its own devDependency (`valibot` in `platforms/cloudflare/src`)   | yes           | no                              | n/a                      | n/a                            |
| Import of a dependency only the root declares (`effect` in `libraries/machine`)          | yes           | no (only with `--strict`)       | n/a                      | n/a                            |
| Undeclared import in a file no entry reaches (`oxc-parser` in an orphan machine file)    | yes           | no                              | n/a                      | n/a                            |
| Declared, never imported (`@file-transfer/machine` in sink)                              | yes           | yes                             | n/a                      | n/a                            |
| Forbidden kind edge as an `import` (service `room` imports `platform-cloudflare`)        | yes           | no                              | n/a                      | yes                            |
| The same edge as a re-export (`export * as x from "@file-transfer/platform-cloudflare"`) | yes           | no                              | n/a                      | no                             |
| Forbidden edge between two packages of one kind (service `room` imports `service-quota`) | yes           | no                              | n/a                      | no (per-kind elements)         |
| Cycle between two files of one package                                                   | no            | yes, with `--include cycles`    | yes, both files          | n/a                            |

- **knip** needs entry points for files run as scripts (`tools/quality/src/check*.ts`, `apps/web/scripts/**`, `alchemy.run.ts`) and to ignore `cloudflare:workers`. Without them it reports 17 unused files, all false, and 11 unlisted dependencies: 9 `cloudflare:workers` imports (false), `@effect/language-service` (used through `tsconfig.json`) and `ws` in `spikes/0003` (false: that spike's own `package.json` declares it, but spikes are not workspaces, so knip reads them as part of the root; `ignore: ["spikes/**"]` removes them, while the spike's `ignoreWorkspaces` has no effect). Configured (`knip.json` with five workspace entries), dependency checks only, it reports three items worth a look: the root `effect` dependency, `@effect/tsgo` (used only through configuration), and `workerd` in `platforms/cloudflare` (wrangler brings its own), plus `ws` as above. knip reads only files reachable from an entry, and it treats the root's dependencies as available to every workspace, shipped code included. Outside `--strict` it does not report an undeclared import of a workspace package or of a root-only dependency; `--strict` catches both, but reports 24 items on a clean `main`, mostly false (with this configuration it marks every Cloudflare platform dependency unused). It also has a `cycles` issue type, which finds the planted cycle.
- **oxlint `import/no-cycle`** builds a project-wide module graph natively (oxlint's multi-file analysis) and found the planted file cycle in about 1 s over the whole repository. `check:graph` checks cycles between packages only.
- **oxlint-plugin-boundaries** classifies by path with a `package.json` name index and an allow-matrix, the same model as `check:graph`'s kind table. It loads under oxlint 1.86.0 (and 1.89.0, which Vite+ 1.4.0 ships) and caught the forbidden edge written as an `import`. It treats an import whose two ends have the same element type as a self-import and always allows it (its README says so), so with one element type per kind it allows every edge between two packages of one kind: service to service, platform to platform, integration to integration and app to app, all of which the kind table forbids. One element type per package, with the allow-matrix generated from the kind table, closes that; measured for `service-quota`. It visits `import` declarations only, so the same edge written as a re-export passes. (A first run of this spike planted the re-export and read the silence as the plugin not loading; round 1 of the review found the error.)
- **dependency-cruiser** was not run: its stable release does not support TypeScript 7.0 yet (its issue 1112).
- **import-integrity-lint** (1.3.1) was not run: ESLint-first, with `@typescript-eslint` and `zod` dependencies. Its registry entry says it catches architectural violations as well as dead exports and broken imports, so it is a candidate this spike did not measure.

## Timings

| Command                                             | Time               |
| --------------------------------------------------- | ------------------ |
| `bun run check:graph`                               | 0.34 s             |
| `knip --include dependencies,unlisted`              | 1.6 s              |
| oxlint with only `import/no-cycle`, whole repo      | 1.0 s              |
| `vp run --cache check:graph`, first run, then a hit | 1.7 s, then 0.09 s |

`vp run --cache` runs in this Bun workspace, which its install guide does not list (only pnpm, npm and Yarn): a modified input (`libraries/sink/src/index.ts`, or a `package.json`) made it miss; after reverting the file, the next run missed once more and the one after hit. A newly added file did not: the cached run replayed a pass ("cache hit, replaying", 0 violations) where a direct run failed. The miss is specific to Bun: a `readdirSync` probe run under Node with `vp run --cache` missed when a file was added ("cache miss: 'b-node.txt' added in 'probe-dir'"), and the same probe under Bun replayed the stale result. So a Bun task that discovers files by listing directories, `check:graph` included, should not be cached that way.

## Findings

1. **knip replaces one of `check:graph`'s rules outright**: declared-but-unused dependencies, and it extends it to devDependencies and the root, which `check:graph` never read. It does not replace the undeclared-import rule, for workspace packages, root-only dependencies, a package's own devDependencies in shipped code, or files no entry reaches, so that rule stays. It also checks more (unused files and exports, unlisted binaries, cycles) once its entry points are declared.
2. **oxlint's native `import/no-cycle` covers what `check:graph` does not**: cycles inside a package, on a real module graph, already in the toolchain (`vp check` runs oxlint).
3. **oxlint-plugin-boundaries can do the kind-edge rule inside oxlint**, for `import` declarations, if each package is its own element type and the allow-matrix is generated from the kind table; with one element type per kind it allows edges inside a kind. It misses re-exports, and has no notion of which outside packages each kind may use, runtime modules or test-only specifiers in shipped code, relative imports that leave a package, or computed `import()`. vektorprogrammet-reimagined's layers inside a package with a shrink-only baseline are also unique to our copies.
4. **The scanner is where the copies drift.** Whatever owns the remaining rules should read imports, re-exports and dynamic imports with oxc-parser, and resolve them with oxc-resolver so edges are files, not guessed package names.
5. **An oxlint plugin works as the front end.** JS plugins load in the oxlint Vite+ ships, so rules that need only the file being linted and a resolver can live in `vp check`. Oxlint gives its module graph to built-in rules only, so a JS plugin resolves imports itself.

## Proposal

Decided by the owner on 2026-10-30, after round 2 of this spike's review: adopt knip and oxlint's cycle rule, and put every other rule in one tool of our own, `ox-dep-lint`. oxlint-plugin-boundaries is not adopted (finding 3), and the pull request prepared for it is not sent.

- Adopt knip for dependency hygiene (unused and unlisted packages, unresolved imports, binaries) with this spike's entry points, and oxlint's `import/no-cycle` for file cycles (Ultracite's core preset already turns it on). knip's own `cycles` type only warns unless its rule is set to `error`, so `import/no-cycle` is the check.
- Build `ox-dep-lint` as an oxlint plugin for the rest: kind edges between packages, read from imports, re-exports and literal `import()`; outside packages per kind; runtime and test-only modules in shipped code; relative imports that leave a package; computed `import()`; undeclared imports (workspace packages, root-only dependencies, devDependencies in shipped code); and layers inside a package with a shrink-only baseline. Then move vektorprogrammet-reimagined and reebeat onto the same set, with pull requests to each.
- Keep `check:graph` until each rule it enforces has a replacement that a negative control proves.

## Sources

- knip issue types: https://knip.dev/reference/issue-types
- oxlint multi-file analysis: https://oxc.rs/docs/guide/usage/linter/multi-file-analysis
- oxlint JS plugins (alpha): https://oxc.rs/docs/guide/usage/linter/js-plugins
- oxlint-plugin-boundaries: https://registry.npmjs.org/oxlint-plugin-boundaries (self-imports: its README, and `dist/index.js` of 0.1.0)
- import-integrity-lint: https://registry.npmjs.org/import-integrity-lint
- dependency-cruiser and TypeScript 7: https://github.com/sverweij/dependency-cruiser/issues/1112
- Vite+ cache: https://viteplus.dev/guide/cache
- Vite+ install (package managers): https://viteplus.dev/guide/install
