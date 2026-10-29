# Damaged link

A link whose key was cut or mistyped cannot open the parcel. The recipient's page fails with a clear reason instead of downloading anything, and the sender keeps waiting for the real recipient. A well-formed but wrong key is refused by the room, which only ever sees a hash of the room token.

## Sub-features

- `damaged-invalid-secret` fails a fragment that is not a valid key with `invalid-secret`.
- `damaged-sender-waits` leaves the sender at `waiting-for-recipient`.
- `damaged-wrong-token` (endToEnd.ts only) refuses a well-formed wrong key with `wrong room token`.

## How to get to it (user POV)

- Recipient: open a link whose part after `#` was cut short or changed.

## Driving it with drive.ts

Preconditions:

- Doctor passes for the origin.

- **Offer.** The sender seals `verify-wrong-key.bin` (10 KB) and reveals the link.
- **Open a damaged link.** The recipient opens the link with its fragment replaced by `#AAAA`. Recipient status becomes `failed` and `fileTransferTest.failure()` is `invalid-secret` (`02-recipient-damaged-link`).
- **Sender keeps waiting.** Sender status stays `waiting-for-recipient`.
- Command: `bun apps/web/scripts/verify/drive.ts wrong-key <origin> <run>/evidence`. Ends with `PASS wrong-key`.

## Gotchas

- The well-formed wrong key case needs a second valid-looking secret; `apps/web/scripts/endToEnd.ts` (`wrongKey`) drives it, `drive.ts` does not yet.
- The fragment never reaches the server, so a server log can never show this failure; only the recipient page can.
