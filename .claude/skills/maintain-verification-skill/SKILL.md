---
name: maintain-verification-skill
description: Periodic pass that keeps .claude/skills/verify-file-transfer and its feature map honest, with parallel source readers per feature, one live session driving every feature, and at most one pull request of proven corrections. Use when asked to audit, refresh or maintain the verification skill, or after a change that adds or renames a user-facing feature.
disable-model-invocation: true
---

# Maintain the verification skill

Adapted from pstack's `maintain-verification-skill` (cursor/plugins, MIT, copyright 2026 Lauren Tan; licence in `.claude/skills/PSTACK-LICENSE.txt`). Changes: paths for this repository, the launch model of `verify-file-transfer` named in invariant 3, and shipping through `open-pull-request`. Like the original, it runs only when asked (`disable-model-invocation`).

A feature map rots the moment the app changes. This is the upkeep loop for `.claude/skills/verify-file-transfer`. The unit of rigour is the feature, not every sentence: cover every feature file from source and exercise every feature live.

## Outcomes

Pick one, and say which:

- **clean**: every feature got source and live coverage; nothing worth shipping. No branch, no pull request.
- **changed**: one pull request ships proven doc, harness or map corrections.
- **blocked**: coverage could not finish or a proven fix could not ship safely. Say exactly what blocked it.

## Edit scope

Only the verification skill's own files: `.claude/skills/verify-file-transfer/` (SKILL.md and `features/`) and the harness it owns, `apps/web/scripts/verify/`. Never edit product code during a pass. Behaviour the map describes that the app no longer has is either doc drift (fix the map) or a product regression (report it, do not paper over it in the map).

## Pass

0. **Locate the target.** `.claude/skills/verify-file-transfer/`. If it is missing, stop and say so; do not invent one.
1. **Index hygiene.** Read `features/README.md` and list its sibling files. Fix missing, extra, duplicate or dead entries, and check the "Not yet mapped" list against the app's features (routes in `platforms/cloudflare/src/worker.ts`, pages in `apps/web/src/main.ts`, scenarios in `apps/web/scripts/endToEnd.ts`).
2. **Source wave.** One read-only subagent per feature file, launched together. Each explains how the user-facing feature works from source, flags likely drift with `file:line` citations, and returns one concise live recipe. Return shape: feature summary / source entry points / likely drift or none / one recipe. Subagents never drive the app and never edit files.
3. **Reconcile.** Every feature file has a returned summary. Merge overlapping recipes into as few app states as practical. Spot-check cited drift; do not re-prove clean claims. Sweep recent churn (`git log --since` on `apps/web/src`, `platforms/cloudflare/src`, `libraries/transport/src`) for user-facing surfaces missing from the map; require a concrete source path before calling one missing.
4. **Live pass.** Required even when source looks clean. You drive, alone, following the skill's Launch: one local instance (`launch.ts`), driven serially. Exercise every feature at least once (`drive.ts` journeys, plus a scratch script for any mapped sub-feature no journey covers). Hold three invariants the whole pass: (1) run `doctor.ts` before the first drive and after any failed drive, and relaunch rather than hope; (2) evidence captured so far survives every cleanup, checked under `<run>/evidence`, not assumed; (3) nothing a drive started outlives that drive's usefulness: residue from a failed iteration is cleaned whether the session is stuck, exited or shared (for a shared instance, clean the residue, not the instance), and `stop.ts` runs after the last drive and after every failed or interrupted launch. A doctor failure caused by skill drift is drift: fix it under edit scope and retry once before calling the pass blocked. A feature that cannot be reached is `verified-unreachable` only with the concrete prerequisite and the route attempted; if the map omits that prerequisite, that is drift. Any harness fix gets re-driven live before it ships.
5. **Triage.** Wrong or missing user-view description: doc drift, fix it. Working behaviour the harness cannot drive: harness gap, fix it (helpers stay executable with `bun` and their invocation documented in SKILL.md). Broken app behaviour: product gap; record it for the user and keep it out of this pull request.
6. **Ship or stop.** For changed: one pull request through `open-pull-request`, after re-reading every changed file and running `bun run check`. For clean or blocked: no pull request; report the outcome and the coverage honestly.

Keep concise run notes (features covered, unreachable prerequisites, confirmed drift, outcome) in the scratchpad; do not commit them.
