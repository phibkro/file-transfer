---
name: verify-file-transfer
description: Drive the file transfer web app the way a sender and a recipient do, against a local instance or a pull request preview, and capture evidence (screenshots, ARIA snapshots, every URL and socket frame the browsers sent). Use to prove a change works before calling it done, to verify a pull request, or when asked to verify, smoke test or reproduce behaviour in the app.
---

# Verify file transfer

The product is a web app (`apps/web`) served by a Cloudflare Worker with Durable Object rooms (`platforms/cloudflare`). A user touches the web UI only: a sender chooses files and shares a link, a recipient opens it, reviews the offer and accepts. Every journey therefore needs two isolated browser profiles. The server is a second surface (HTTP API and room sockets), but users reach it only through the app, so drive it through the app.

Generated on 2026-10-29 by following pstack's `create-verification-skill` (cursor/plugins, MIT, Lauren Tan). Keep it honest with `.claude/skills/maintain-verification-skill`.

## Launch

```sh
bun apps/web/scripts/verify/launch.ts            # prints {"run": "<run directory>", "origin": "http://127.0.0.1:<port>"}
```

The launcher builds both packages and copies their output into `<run>/build`. It starts Wrangler with isolated state under `<run>/state`. Readiness requires the application mount and a JSON response from `/api/limits`, not a particular product title. `server.json` records the origin, process group, revision, dirty-tree digest and readiness. Evidence and logs stay in the run directory. Interrupted or failed launches stop their server.

Instances are isolated by port, state directory and build copy, so two runs can live side by side; launches themselves rebuild the checkout, so start them one at a time. The run directory must be outside the checkout (launch refuses one inside, symbolic links resolved, since its files would count as uncommitted edits) and must not already hold a server (stop it first, or relaunch into a new directory). Never drive a server you did not start in this run, and never drive production (`send.phibkro.org`).

To verify a pull request without launching anything, use its preview: the `github-actions` bot comments `Preview: https://<hash>-file-transfer.philib-krogh-d23.workers.dev (commit <sha>)` on every pull request. Check that the commit in that comment is the pull request's head before trusting it.

## Doctor

```sh
bun apps/web/scripts/verify/doctor.ts <run directory>   # a local instance from launch.ts
bun apps/web/scripts/verify/doctor.ts https://...       # a preview
```

Read-only. For a run directory it checks that launch finished (`ready`), that the recorded server process is alive, and that it was built from the revision and the uncommitted edits checked out now; then (for both) that the origin serves the app and `/api/limits` answers JSON. Exit code 0 means worth driving. Run it before the first drive, after any failed drive, and after any edit or branch switch (a mismatch means stop and relaunch).

## Drive

```sh
bun apps/web/scripts/verify/drive.ts <journey> <origin> <run directory>/evidence [chromium | firefox | webkit]
```

Journeys, one per feature file in `features/`: `send-receive`, `decline`, `wrong-key`, `resume`, `library`. Each opens two fresh Playwright profiles and prints the result of every step. The final `PASS` or `FAIL` line matches the exit code.

To use a system browser, set `E2E_BROWSER_EXECUTABLE_PATH=/etc/profiles/per-user/nori/bin/chromium` before the drive command. Omit it to use the Playwright default. On Nix hosts, use a stable run directory outside the nix-shell `TMPDIR`, such as a directory under `/var/tmp`. Pass that directory to launch, doctor, drive, and stop.

For behaviour no journey covers, write a short Playwright script in the scratchpad that follows the same conventions (features/README.md, Driving conventions). Stable handles in this app:

- Sender: file input `#files`, list `.file-list li`, button `Seal parcel and create link`, buttons `Show link`, `Show QR code`, `Send other files`, link field `#link`.
- Library: `#library`, switch `Remember files on this device`, `New collection`, `New collection name`, `Create empty collection`, `Add to catalog`, the dialog file input, collection filter buttons, `Find a file`, `Manage <filename>`, `Reconnect <filename>`, `Review collection before sharing`, and `Approve and share current versions`.
- Recipient: buttons `Accept` (or `Accept and download … on mobile data`), `Decline`, `Save all files` (`Save all files to a folder` where the browser has a folder picker), `Remove from this browser`, per file `Rename <name>`, `Preview <name>`, `Save <name>`.
- State: `document.body.dataset.status` and the test hook `window.fileTransferTest` (`status()`, `progress()`, `failure()`, `failureDetail()`, `fileHashes()`, `path()`, `wentDirect()`), from `apps/web/src/report.ts`. Statuses (`Status` in report.ts): sender `idle`, `labelling`, `creating-room`, `waiting-for-recipient`, `offering`; recipient `connecting`, `waiting-for-sender`, `reviewing`; both `reconnecting`, `transferring`, `complete`, `declined`, `failed`.
- Relay only: set `localStorage["file-transfer:direct-connections"] = "off"` in an init script before the page loads (the "Direct connections" setting).

## Evidence

Each journey writes to `<evidence>/<journey>/`:

- `NN-<side>-<state>.png` and `NN-<side>-<state>.aria.yml`: a full-page screenshot and the ARIA snapshot after each step, so the proof shows the action and the state it left, with the app's heading visible.
- `sent.json` (send-receive and library): observed request URLs, bodies, and socket frames, checked for link secrets and file names. Secret and name matches are redacted in the evidence. Worker, new `about:blank` frame, and stream bodies are not seen (`apps/web/scripts/requestBodies.ts`).
- `result.json`: journey, origin, browser, each step's action and observed outcome, the failure if any, and `failedSides`: each side's status, failure reason and detail when the journey failed.
- `failed-<side>.png` and `failed-<side>.aria.yml`: each page as it was when a journey failed.

Proof standards:

- Drive the real user path: buttons by accessible name, the real link, the real server. The test hook is read only to observe state, never to cause it.
- A transfer is proven by both sides reaching `complete` and the recipient's SHA-256 of every file equalling the sender's, not by a progress bar.
- Faults are injected at the network boundary (Playwright WebSocket routing, `localStorage` settings), never by calling internals.
- When you cite evidence in a pull request or review, give the journey, the origin (local revision or preview commit) and the `PASS` line, and keep the files in the run directory.

## Cleanup

```sh
bun apps/web/scripts/verify/stop.ts <run directory>
```

Kills exactly the process group `launch.ts` recorded (never by name) and deletes `<run>/state`; with no `server.json` it says there is nothing to stop. `<run>/evidence` and `server.log` stay. Run it after the last drive, and after every failed or interrupted launch, so no `wrangler` or `workerd` outlives the run. Playwright browsers close when `drive.ts` exits.

In a worktree-isolated agent the shell may refuse compound commands that contain `git` or expanded paths; run the helpers one command per call.

## Helpers

All in `apps/web/scripts/verify/`, executable with `bun`, linted and type-checked with the rest of the repository: `launch.ts`, `doctor.ts`, `drive.ts`, `stop.ts`. The deeper suites stay in `apps/web/scripts/endToEnd.ts` (`E2E_SUITE=standard | completion | life-cycle | chaos | lab | large | latency | scenario`, see its header); use them for fault injection and network emulation beyond these journeys.

## Feature map

`features/README.md` indexes the user-facing features and how to drive each one. Read it before driving.
