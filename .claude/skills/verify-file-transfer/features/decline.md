# Decline an offer

A recipient who does not want what is offered chooses `Decline`. Nothing is downloaded, the recipient page says so, and the sender's page shows that the offer was refused.

## Sub-features

- `decline-recipient` ends the recipient at `declined` with nothing downloaded.
- `decline-sender` tells the sender, which ends at `declined`.

## How to get to it (user POV)

- Recipient: open a link, read the offer, choose `Decline`.

## Driving it with drive.ts

Preconditions:

- Doctor passes for the origin.

- **Offer.** The sender seals `verify-decline.bin` (10 KB) and reveals the link, as in send-and-receive.
- **Open the link.** Recipient status becomes `reviewing`.
- **Decline.** Choose `Decline`. The recipient ends at `declined` (`02-recipient-declined`); the sender ends at `declined` (`03-sender-declined`).
- Command: `bun apps/web/scripts/verify/drive.ts decline <origin> <run>/evidence`. Ends with `PASS decline`.

## Gotchas

- The decline travels as a control message; if the recipient's socket is reconnecting at that moment the message is dropped and the sender keeps waiting (docs/spikes/0006, finding R5; the spike lands with pull request #15). This journey does not cover that case.
- After a failure the `Decline` button may still be on the page and still act (spike 0006, R2); a journey that declines after a failure would report `declined` over `failed`.
