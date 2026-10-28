# apps/web

The user interface: drop zone, share link, progress on both sides, landing page, fake doors for paid features, `/abuse` notice form. Bundled with Vite+ and served as static assets by every platform. Built in M2 and M3; the M0 spike harness pages live in `spikes/`.

Security rules for this app: strict Content Security Policy, no third-party scripts, never send `location.hash` anywhere, reproducible builds with published hashes.

## Send and receive (MVP)

- `/` sends: pick or drop files, wait for the labelling pass, share the link, keep the tab open until the recipient finishes.
- `/r/<room>#<secret>` receives: the files on offer appear with Accept and Decline; accepted files are written to the origin private file system and offered as downloads once every record verifies.

| File                                      | Role                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/main.ts`                             | Routes `/` and `/r/<room>`                                                             |
| `src/sender.ts`, `src/recipient.ts`       | Transfer orchestration (moves into `libraries/client` after the MVP, see docs/plan.md) |
| `src/connection.ts`                       | Room socket: join, decode, rejoin with backoff                                         |
| `src/storage.ts`                          | Provisional OPFS output, committed on completion, discarded on failure                 |
| `src/files.ts`, `ranges.ts`, `credits.ts` | Pure bookkeeping, unit tested in `test/`                                               |
| `src/report.ts`                           | Status, progress and the end-to-end test hook                                          |

## Running locally

```sh
bun install
# terminal 1: the room platform on port 8787 (platforms/cloudflare)
# terminal 2:
cd apps/web && bunx vp dev    # http://localhost:5173, /api and its WebSockets proxied to 127.0.0.1:8787
cd apps/web && bunx vp build  # writes apps/web/dist
```

Platforms must answer `/r/*` with `index.html`.

## Test hook

`window.fileTransferTest` exposes `status()`, `progress()` (`{done, total}` records), `failure()` (a reason code) and `fileHashes()` (SHA-256 of each received file once complete). `document.body.dataset.status` and `dataset.progress` mirror the first two. Neither ever holds the link secret or plaintext.
