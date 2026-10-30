# Spike 0007: adopt existing dependency-graph tools, or extract our own

Input for a decision on `tools/quality`'s module graph check (docs/decisions/0009). Three repositories by the same author carry their own copy of this check (this one, phibkro/vektorprogrammet-reimagined, reebeat/reebeat), and they drift: computed `import()` was handled in reebeat long before #29 added it here. Before extracting one shared package (working name `dep-lint`), this spike asks which parts existing tools already do. Run on 2026-10-30 against `main` at e5ee199 in a separate worktree, Bun 1.4.4, oxlint 1.86.0 (the repository's pin; Vite+ 1.4.0 itself ships 1.89.0), Vite+ 1.4.0, and corrected after round 1 of its review.

## Method

Each tool ran with the smallest configuration that matches this repository, then against planted violations, one at a time, next to `bun run check:graph`. Plants were removed after each run. Timings are wall clock on a shared two-core machine, second of two runs.

## What each tool caught

| Planted violation                                                                        | `check:graph` | knip 6.44 (spike's `knip.json`) | oxlint `import/no-cycle` | oxlint-plugin-boundaries 0.1.0 |
| ---------------------------------------------------------------------------------------- | ------------- | ------------------------------- | ------------------------ | ------------------------------ |
| Undeclared import of an outside package (`valibot` in `libraries/sink`)                  | yes           | yes                             | n/a                      | n/a                            |
| Undeclared import of a workspace package (`@file-transfer/machine` in sink)              | yes           | no (only with `--strict`)       | n/a                      | n/a                            |
| Declared, never imported (`@file-transfer/machine` in sink)                              | yes           | yes                             | n/a                      | n/a                            |
| Forbidden kind edge as an `import` (service `room` imports `platform-cloudflare`)        | yes           | no                              | n/a                      | yes                            |
| The same edge as a re-export (`export * as x from "@file-transfer/platform-cloudflare"`) | yes           | no                              | n/a                      | no                             |
| Cycle between two files of one package                                                   | no            | yes, with `--include cycles`    | yes, both files          | n/a                            |

- **knip** needs entry points for files run as scripts (`tools/quality/src/check*.ts`, `apps/web/scripts/**`, `alchemy.run.ts`) and to ignore `cloudflare:workers`. Without them it reports 17 unused files, all false, and 11 unlisted dependencies: 9 `cloudflare:workers` imports (false), `@effect/language-service` (used through `tsconfig.json`) and `ws` in `spikes/0003` (real). Configured (`knip.json` with five workspace entries), dependency checks only, it reports four items worth a look: the root `effect` dependency, `@effect/tsgo` (used only through configuration), `workerd` in `platforms/cloudflare`, and `ws`. Outside `--strict` it does not report an undeclared import of a workspace package; `--strict` does, but reports 24 items on a clean `main`, mostly false. It also has a `cycles` issue type, which finds the planted cycle.
- **oxlint `import/no-cycle`** builds a project-wide module graph natively (oxlint's multi-file analysis) and found the planted file cycle in about 1 s over the whole repository. `check:graph` checks cycles between packages only.
- **oxlint-plugin-boundaries** classifies by path with a `package.json` name index and an allow-matrix, the same model as `check:graph`'s kind table. It loads under oxlint 1.86.0 (and 1.89.0, which Vite+ 1.4.0 ships) and caught the forbidden edge written as an `import`. It visits `import` declarations only, so the same edge written as a re-export passes. (A first run of this spike planted the re-export and read the silence as the plugin not loading; round 1 of the review found the error.)
- **import-integrity-lint** (1.3.1) was not run: ESLint-first, with `@typescript-eslint` and `zod` dependencies. Its registry entry says it catches architectural violations as well as dead exports and broken imports, so it is a candidate this spike did not measure.

## Timings

| Command                                             | Time               |
| --------------------------------------------------- | ------------------ |
| `bun run check:graph`                               | 0.34 s             |
| `knip --include dependencies,unlisted`              | 1.6 s              |
| oxlint with only `import/no-cycle`, whole repo      | 1.0 s              |
| `vp run --cache check:graph`, first run, then a hit | 1.7 s, then 0.09 s |

`vp run --cache` runs in this Bun workspace, which its install guide does not list (only pnpm, npm and Yarn): a modified input (`libraries/sink/src/index.ts`, or a `package.json`) made it miss, and reverting the file made it hit again. A newly added file did not: the cached run replayed a pass ("cache hit, replaying", 0 violations) where a direct run failed. So its inferred inputs do not cover new files a task discovers by listing directories, and `check:graph` should not be cached that way.

## Findings

1. **knip replaces one of `check:graph`'s rules outright**, declared-but-unused dependencies, and the undeclared rule for outside packages. It does not replace the undeclared rule for workspace packages (outside `--strict`), so that rule stays. It also checks more (unused files and exports, unlisted binaries, cycles) once its entry points are declared.
2. **oxlint's native `import/no-cycle` covers what `check:graph` does not**: cycles inside a package, on a real module graph, already in the toolchain (`vp check` runs oxlint).
3. **oxlint-plugin-boundaries already does the kind-edge rule inside oxlint**, for `import` declarations. It misses re-exports, and has no notion of which outside packages each kind may use, runtime modules or test-only specifiers in shipped code, relative imports that leave a package, or computed `import()`. vektorprogrammet-reimagined's layers inside a package with a shrink-only baseline are also unique to our copies.
4. **The scanner is where the copies drift.** Whatever owns the remaining rules should read imports, re-exports and dynamic imports with oxc-parser, and resolve them with oxc-resolver so edges are files, not guessed package names.
5. **An oxlint plugin works as the front end.** JS plugins load in the oxlint Vite+ ships, so rules that need only the file being linted and a resolver can live in `vp check`. Oxlint gives its module graph to built-in rules only, so a JS plugin resolves imports itself.

## Proposal

Decided by the owner on 2026-10-30: contribute upstream first.

- Adopt knip (dependencies, unlisted, cycles) with this spike's entry points, oxlint's `import/no-cycle`, and oxlint-plugin-boundaries for kind edges.
- Send oxlint-plugin-boundaries a pull request so it visits re-exports (`export ... from`, `export * from`) and literal dynamic `import()`.
- Build `ox-dep-lint` as an oxlint plugin for the rules nothing else covers: outside packages per kind, runtime and test-only modules in shipped code, relative imports that leave a package, computed `import()`, undeclared workspace imports, and layers inside a package with a shrink-only baseline. Then move vektorprogrammet-reimagined and reebeat onto the same set, with pull requests to each.
- Keep `check:graph` until each rule it enforces has a replacement that a negative control proves.

## Sources

- knip issue types: https://knip.dev/reference/issue-types
- oxlint multi-file analysis: https://oxc.rs/docs/guide/usage/linter/multi-file-analysis
- oxlint JS plugins (alpha): https://oxc.rs/docs/guide/usage/linter/js-plugins
- oxlint-plugin-boundaries: https://registry.npmjs.org/oxlint-plugin-boundaries
- import-integrity-lint: https://registry.npmjs.org/import-integrity-lint
- dependency-cruiser and TypeScript 7: https://github.com/sverweij/dependency-cruiser/issues/1112
- Vite+ cache: https://viteplus.dev/guide/cache
- Vite+ install (package managers): https://viteplus.dev/guide/install
