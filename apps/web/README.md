# apps/web

The user interface: drop zone, share link, progress on both sides, landing page, fake doors for paid features, `/abuse` notice form. Bundled with Vite+ and served as static assets by every platform. Built in M2 and M3; the M0 spike harness pages live in `spikes/`.

Security rules for this app: strict Content Security Policy, no third-party scripts, never send `location.hash` anywhere, reproducible builds with published hashes.

## Send and receive (MVP)

- `/` sends: pick or drop files, rename or preview them, seal the parcel (the labelling pass; names and files are fixed from then on), share the link, keep the tab open until the recipient finishes.
- `/r/<room>#<secret>` receives: the files on offer appear with Accept and Decline; accepted files are written to the origin private file system and offered as downloads once every record verifies. The recipient can rename what each file is saved under, and preview verified files.
- Received files are decrypted, so they do not outlive the page: each transfer's folder is held by a Web Lock while its page is open, and every page load deletes folders no lock holds (interrupted transfers and finished ones whose tab is gone). Leaving with a transfer running or files unsaved asks first. "Storage in this browser" on every page shows what is stored and clears it.

| File                                                    | Role                                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/main.ts`                                           | Routes `/` and `/r/<room>`                                                                    |
| `src/sender.ts`, `src/recipient.ts`                     | Transfer orchestration (moves into `libraries/client` after the MVP, see docs/plan.md)        |
| `src/connection.ts`                                     | Room socket: join, decode, rejoin with backoff                                                |
| `src/storage.ts`                                        | Provisional OPFS output, committed on completion, discarded on failure, swept on load         |
| `src/preview.ts`, `src/previewFrame.ts`, `preview.html` | Previews in a sandboxed, opaque-origin frame (ADR 0018); `public/_headers` sandboxes the page |
| `src/sniff.ts`, `src/rename.ts`, `src/selection.ts`     | What a file previews as (from its bytes); renaming against the parcel's name rules            |
| `src/storagePanel.ts`, `src/leaveGuard.ts`              | Storage in this browser (size, Clear); asking before leaving would lose something             |
| `src/files.ts`, `ranges.ts`, `credits.ts`               | Pure bookkeeping, unit tested in `test/`                                                      |
| `src/report.ts`                                         | Status, progress and the end-to-end test hook                                                 |
| `scripts/endToEnd.ts`                                   | Two isolated browsers against the real room server (`bun run e2e`)                            |

## Running locally

```sh
bun install
# terminal 1: the room platform on port 8787 (platforms/cloudflare)
# terminal 2:
cd apps/web && bunx vp dev    # http://localhost:5173, /api and its WebSockets proxied to 127.0.0.1:8787
cd apps/web && bunx vp build  # writes apps/web/dist
```

Platforms must answer `/r/*` with `index.html`.

## End-to-end check

```sh
cd apps/web && bun run build && bun run e2e                 # starts wrangler dev from platforms/cloudflare
BASE_URL=https://<deployed host> bun run e2e                  # drives a deployed Worker instead
```

Two isolated Chromium profiles send and receive through the real room Durable Object: four files including an empty one, a 16 MB transfer whose sockets are cut mid-transfer (cleanly, then half-open), a 256 MB throughput run, a decline and wrong keys. Every file must arrive with the same SHA-256, and no request URL or socket frame either browser sends may contain the link secret or a file name.

## Test hook

`window.fileTransferTest` exposes `status()`, `progress()` (`{done, total}` records), `failure()` (a reason code) and `fileHashes()` (SHA-256 of each received file once complete). `document.body.dataset.status` and `dataset.progress` mirror the first two. Neither ever holds the link secret or plaintext.
