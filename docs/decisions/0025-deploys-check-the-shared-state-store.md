# 0025 Deploys check the shared Alchemy state store first

Status: accepted (2026-10-30).

## Context

Alchemy keeps each stack's state in a state-store Worker (`alchemy-state-store`) in the Cloudflare account, and one account's store is shared by every repository that deploys there with Alchemy: this one, heim, filmder and finnbydel. Each Alchemy release expects one version of the store's contract (`STATE_STORE_VERSION` in `@alchemy.run/cloudflare`'s `StateStore/Api.ts`). Read in the installed 2.0.0-beta.84 (`StateStore/State.ts`, alchemy's `State/Provisioning.ts`):

- When a deploy or destroy opens the store, a failed `/version` probe (`isStateStoreServing`, `ensureLatest`) counts as a missing store, and Alchemy deploys a new one, with new secrets.
- A store at any other version, older or newer, counts as out of date, and Alchemy redeploys it at its own version: an older Alchemy downgrades a newer store.
- In CI both happen only with `--yes`, and `--yes` is also what lets a deploy proceed without a prompt. `alchemy destroy` takes the same path (`deploy.ts` passes `updateStateStore: options.yes` for both commands), because a destroy reads and writes the stack's state.

Every deploy job here runs with `--yes`: `checks.yml`'s `preview`, `preview-cleanup` and `production`, and `relay-load.yml`'s deploy and destroy. So a CI run whose Alchemy expects a different version than the store answers, or one that catches the store in a failed probe, could downgrade the store under the other repositories or replace it, cutting them off from their state.

Versions measured on 2026-10-30: beta.79, beta.80, beta.83 and the published beta.84 all expect v7. Alchemy's main branch after beta.84 expects v8 (failures behind its auth answer as a typed `StateStoreFailure`), so the next release will need the store upgraded.

## Decision

1. **Every `alchemy deploy --yes` and `alchemy destroy --yes` in CI runs after a check** (`.github/actions/state-store-preflight`): it reads the version the installed Alchemy expects from `StateStore/Api.ts` (source or compiled), reads the account's workers.dev subdomain, asks the store's `/version` (retrying for about 30 seconds), and fails the job unless the two match. It prints Cloudflare's error codes when the subdomain cannot be read. The step is the one heim, filmder and finnbydel run, kept in one composite action here because five jobs need it.
2. **Destroys are checked too**, for the reason above. `relay-load.yml` destroys its Preview even after a failed step, so its destroy runs only when its own check passed; when the deploy step was skipped there is nothing to destroy.
3. **The store is bootstrapped or upgraded only from a machine**, deliberately, once for every repository that shares it: `bun run --bun alchemy state bootstrap --backend cloudflare --profile production` from `platforms/cloudflare`, with `--force` to redeploy an existing store. Then each repository moves to an Alchemy that expects the new version.

## Consequences

- A store at another version stops deploys, Previews and their cleanup with a message naming both versions, instead of changing the store. Rerunning after the upgrade continues them. A Preview whose cleanup stopped stays until that rerun.
- The check narrows the window rather than closing it: Alchemy's own probe can still fail in the seconds after the check passes. Closing it needs Alchemy to refuse, rather than replace, a store it cannot reach in CI.
- Upgrading Alchemy past a store version is a coordinated change across the repositories that share the account, never one repository's dependency update.
- The check needs no new token permission: Alchemy reads the same subdomain to find its store.
