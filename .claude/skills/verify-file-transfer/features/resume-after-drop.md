# Resume after a dropped connection

When the recipient's connection to the room drops in the middle of a transfer (a server restart, a network change), the page reconnects on its own, asks for what is missing, and finishes with every file intact. The user sees "reconnecting" briefly and does nothing.

## Sub-features

- `resume-rejoin` opens a new socket after the old one closes.
- `resume-relay` finishes the transfer through the relay with identical files.

## How to get to it (user POV)

- Recipient: accept an offer, then lose the connection while it downloads; nothing to choose.

## Driving it with drive.ts

Preconditions:

- Doctor passes for the origin.
- Relay only: drive.ts turns "Direct connections" off for this journey, so the records travel the socket that gets cut.

- **Offer.** The sender seals `verify-resume.bin` (24 MB random) and reveals the link.
- **Open and accept.** Recipient status becomes `reviewing`; choose `Accept`.
- **Cut the connection.** At 30% progress drive.ts closes the recipient's room socket with code 1012 through Playwright's WebSocket routing.
- **Finish.** Both sides reach `complete` (`03-recipient-complete`, `04-sender-complete`); SHA-256 matches; at least 2 sockets were opened; `fileTransferTest.wentDirect()` is `false`.
- Command: `bun apps/web/scripts/verify/drive.ts resume <origin> <run>/evidence`. Ends with `PASS resume`.

## Gotchas

- With the direct path on, records do not travel the cut socket and the journey proves nothing about resuming; keep the relay-only setting.
- A half-open drop (the server never hears the close), silent sockets and joins that are never answered need the chaos suite: `E2E_SUITE=chaos bun run e2e` in `apps/web`.
- On a slow preview the 24 MB transfer can finish before 30%; if the cut step fails with the transfer already complete, the run proves nothing and must be repeated, not counted.
