# File transfer verification map

The maintained source for verifying what a sender and a recipient can do in the web app. Read this index before driving, then use the matching feature file as the recipe. Shape and rules follow pstack's feature map example (cursor/plugins, MIT, Lauren Tan).

## Baseline preconditions

- An instance launched by this run (`bun apps/web/scripts/verify/launch.ts`), or a pull request preview whose comment names the head commit.
- `bun apps/web/scripts/verify/doctor.ts <run directory | preview URL>` exits 0.
- Two fresh browser profiles per journey, one per side; `drive.ts` makes them. Never reuse a profile across journeys: received files and settings live in the browser.
- Direct connections are on unless the feature file says relay only.

## Driving conventions

- Drive through `bun apps/web/scripts/verify/drive.ts <journey> <origin> <run>/evidence`. For a variation no journey covers, write a scratch Playwright script with the same handles and evidence shape.
- Choose buttons by accessible name (`getByRole("button", { name })`), never by position.
- Read state through `window.fileTransferTest` and `document.body.dataset.status`; never call into the app to cause a state.
- Inject faults at the boundary only: Playwright WebSocket routing for sockets, `localStorage` settings for the direct path.
- Every journey creates its own room and files; nothing needs restoring afterwards.

## Proof and skip reporting

- Capture each side after each step: a full-page screenshot and an ARIA snapshot, named `NN-<side>-<state>`.
- A transfer is proven by both sides at `complete` and identical SHA-256 per file, not by the progress bar.
- A privacy claim is proven by `sent.json`: no request URL or socket frame either browser sent carries the link secret or a file name.
- Record the journey, origin (local revision or preview commit) and browser with every artifact; `result.json` does this.
- Report an unreachable path with the command tried and the unmet precondition (for example a browser without a folder picker).
- Do not report a feature verified through a different entry point than the one the change touched.

## Feature entry contract

Each feature file starts with an H1 and one paragraph on the user-visible behaviour, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with drive.ts` (starting with `Preconditions:`, then labelled bullets pairing a user action with the exact command and the observable result), `Gotchas`. Keep implementation details out; name user paths, handles, required state, commands and proof.

## Features

- [Send and receive](./send-and-receive.md): a sender seals files into a link, the recipient reviews, accepts and gets identical files; nothing secret leaves the browsers.
- [Decline an offer](./decline.md): the recipient refuses and the sender sees it; nothing is downloaded.
- [Damaged link](./damaged-link.md): a link with a broken key fails on the recipient, and the sender keeps waiting for the real recipient.
- [Resume after a dropped connection](./resume-after-drop.md): the recipient's connection drops mid-transfer and the transfer finishes on a new one, relay only.

Not yet mapped (covered only by `apps/web/scripts/endToEnd.ts` today): previews and renaming, the storage panel, saving all files to a folder, the operator page `/admin`, transfers under seeded network faults (`E2E_SUITE=chaos`) and emulated home networks (`E2E_SUITE=lab`).
