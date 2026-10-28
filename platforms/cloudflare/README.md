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
- `bun run integration` builds, starts `wrangler dev` on a random port with a stub page as assets, and runs the room checks; it exits non-zero on the first failure.

## Not yet here

Layers implementing the services' tags (`services/room`, `relay`, `quota`, `abuse`, `telemetry`) and their conformance suites against these objects; Turnstile on room creation; TURN credentials; deployment.
