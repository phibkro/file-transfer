# platforms/cloudflare

The Worker and Durable Objects that run the service on Cloudflare (and, unchanged, on workerd for self-hosting, docs/decisions/0004).

## What is here (MVP)

| File                     | Role                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/room.ts`            | Pure room logic: admission, roles, routing and presence per `docs/protocol.md`; no I/O, unit tested in `test/room.test.ts`                |
| `src/roomObject.ts`      | `RoomObject`, one Durable Object per room on the hibernation API; carries out `room.ts` decisions                                         |
| `src/worker.ts`          | `POST /api/rooms`, `GET /api/rooms/<id>/socket`, static assets of `apps/web` with the single-page fallback                                |
| `src/workers.d.ts`       | The Workers API slice this package uses, typed inside the `cloudflare:workers` module so the DOM types of the root program stay untouched |
| `wrangler.jsonc`         | Durable Object binding and SQLite migration, assets from `../../apps/web/dist`, `run_worker_first` for `/api/*`, compression off          |
| `scripts/integration.ts` | Drives a room over real WebSockets against `wrangler dev`                                                                                 |

The room stores only `{roomTokenHash, maximumRecipients}`, written once at creation, and an idle alarm (24 h after creation or after the last participant leaves). Nothing is written per frame, and frames run through no Effect runtime (spike 0001).

## Commands

Run from this directory after `bun install` at the repository root.

- `bun run build` bundles `src/worker.ts` into `dist/worker.js` with esbuild.
- `bun run dev` builds and starts `wrangler dev` on http://localhost:8787. Build `apps/web` first so `../../apps/web/dist` exists.
- `bun run deploy` builds apps/web and the Worker, then deploys stage `production` with Alchemy (`alchemy.run.ts`) using your `production` Alchemy profile, at https://send.phibkro.org (and its workers.dev URL). A wrangler dry run of the same bundle uploads 636 KiB (135 KiB gzipped) with the `ROOMS` Durable Object and the assets.
- `bun run preview <stage>` deploys any other stage (`staging`, `pr-12`) as a [Worker Preview](https://developers.cloudflare.com/workers/previews/) of the production Worker: its own URL, `<stage>-file-transfer.<subdomain>.workers.dev`, and its own Durable Object namespace, so preview rooms never touch production. `bun run destroy:preview <stage>` removes it. Production must exist first.
- `wrangler.jsonc` is the one declaration of the Worker: `wrangler dev` and both checks run on it, and `alchemy.run.ts` deploys from it (it fails on fields it does not map), so local runs and deploys cannot drift. Alchemy needs Node 24 or Bun; the scripts run it under Bun.
- `bun run integration` builds, starts `wrangler dev` on a random port with a stub page as assets, and runs the room checks; it exits non-zero on the first failure.

## Deploying from GitHub Actions

`.github/workflows/checks.yml` deploys after the checks pass: each pull request from a branch of this repository gets a Worker Preview `pr-<number>` (URL commented on the pull request, verified by `apps/web`'s end-to-end check, destroyed when the pull request closes), and each push to main deploys production and verifies https://send.phibkro.org. Forks are only checked. Alchemy reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment and keeps its state in the account's state-store Worker, so CI and local deploys share state.

One-time setup:

1. Create an API token in the Cloudflare dashboard (My Profile, API Tokens) from the "Edit Cloudflare Workers" template, scoped to the deploying account and the `phibkro.org` zone, and add Zone DNS Edit for that zone (the custom domain) and Account Secrets Store Read (alchemy's state-store token lives there). The first run names any missing permission.
2. `gh secret set CLOUDFLARE_API_TOKEN` (paste the token) and `gh secret set CLOUDFLARE_ACCOUNT_ID --body <account id>`.
3. Optionally require a reviewer on the `production` environment (repository Settings, Environments).
4. `gh variable set DEPLOYMENTS --body enabled` turns the deploy jobs on; delete the variable to turn them off.

## Not yet here

Layers implementing the services' tags (`services/room`, `relay`, `quota`, `abuse`, `telemetry`) and their conformance suites against these objects; Turnstile on room creation; TURN credentials.
