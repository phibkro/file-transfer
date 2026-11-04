# apps/web

The browser interface, bundled with Vite+ and served as static assets by every platform. The M0 spike harness pages live in `spikes/`.

Security rules: strict Content Security Policy, no third-party scripts, never send `location.hash` anywhere, reproducible builds with published hashes.

## Quick Share and Library

- `/` is Quick Share: choose or drop files, wait for labelling, share the link, and keep the tab open. Files are not automatically indexed.
- `/library` is Library, separated into On this device and Cloud. Cloud is explicitly unavailable; its future access policy is in [the product plan](../../docs/plan.md#library-product-policy).
- `/r/<room>#<secret>` receives: review the offer, Accept or Decline. Accepted files are provisional OPFS output until every record verifies, then offered as downloads.

On this device is a free, accountless, default-off catalog. Explicitly enable remembering, then **Add files to Library**. IndexedDB retains file handles, names, sizes, modification times, local content fingerprints and collection membership, never file contents. Indexing reads originals locally to establish fingerprints; it does not copy or upload them. Reusable collections reference the originals, so local edits affect future shares.

Before sharing, current file contents are fingerprinted locally and compared with the indexed or last approved versions, including changes preserving size and modification time. Review the files and choose **Share current versions**, or Cancel. Approval updates the comparison baseline, not a claim of successful delivery. The existing sender then creates a fresh secret and room. Active transfers retain their own file list and content commitment. Missing files or denied permissions block the entire selection; reconnecting a reference requires replacement confirmation. No background file monitoring is promised.

Consent epochs reject work started before opt-out, even if another tab re-enables remembering. File and collection revisions reject stale approvals. Turning remembering off atomically forgets the catalog and collections, never original files. Clearing site data also forgets the catalog. This is not a backup.

Persistent file references require a secure context and browser File System Access picker support. Unsupported browsers can still use Quick Share by selecting files each time; there is no automatic copy-based fallback.

| File                                      | Role                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `src/main.ts`                             | Routing and Effect execution boundary                                            |
| `src/sender.ts`, `src/recipient.ts`       | Existing transfer orchestration, planned migration to `libraries/client`         |
| `src/localLibrary.ts`                     | Transactional metadata/file-handle catalog, consent and version checks           |
| `src/libraryView.ts`                      | Device catalog, reusable collections, version review and cloud policy UI         |
| `src/connection.ts`                       | Room socket: join, decode, rejoin with backoff                                   |
| `src/storage.ts`                          | Provisional recipient OPFS output, committed on completion, discarded on failure |
| `src/files.ts`, `ranges.ts`, `credits.ts` | Pure bookkeeping, unit tested in `test/`                                         |
| `src/report.ts`                           | Status, progress and end-to-end test hook                                        |
| `scripts/endToEnd.ts`                     | Isolated-browser transfer suite against the real room server                     |

## Running locally

```sh
bun install
cd apps/web && bun run build
# Separate terminal: cd platforms/cloudflare && bun run dev
# Development frontend, /api and WebSockets proxy to 127.0.0.1:8787:
bun run dev
```

The built application is served by the platform on port 8787; Vite serves development on port 5173. Platforms must answer `/r/*` and `/library` with `index.html`.

## End-to-end check

```sh
cd apps/web && bun run build && bun run e2e
BASE_URL=https://<deployed-host> bun run e2e
```

The existing transfer suite uses isolated Chromium profiles and a real room Durable Object: basic transfer, empty files, disconnect/resume, half-open sockets, throughput, decline and wrong keys. Received hashes must match, and outgoing URLs/socket frames must not contain link secrets or file names. It does not automate the native File System Access picker or the Library journey.

## Test hook

`window.fileTransferTest` exposes `status()`, `progress()` (`{done, total}` records), `failure()` and `fileHashes()` after completion. Body `dataset.status` and `dataset.progress` mirror status and progress. Neither holds link secrets or plaintext.
