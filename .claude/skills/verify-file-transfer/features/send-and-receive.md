# Send and receive

A sender chooses files and seals them into a link; a recipient opens the link, sees what is offered, accepts, and gets every file byte for byte, over a direct path between the browsers when one opens and through the relay otherwise. Neither the link's secret nor any file name ever leaves the browsers.

## Sub-features

- `send-choose` lists every chosen file before sealing.
- `send-seal` seals the files and creates a room and a link.
- `send-link` hides the link until `Show link`, then shows it with its secret in the fragment.
- `receive-review` shows the offer (names, sizes) before anything downloads.
- `receive-accept` downloads, checks every record against the contract, and ends `complete` on both sides.
- `privacy-invariant` keeps the secret and file names out of every request URL and socket frame.

## How to get to it (user POV)

- Sender: open the site, choose files with the file picker, choose `Seal parcel and create link`, then `Show link` or `Show QR code` and share it.
- Recipient: open the shared link, read the offer, choose `Accept`.

## Driving it with drive.ts

Preconditions:

- Doctor passes for the origin.
- Fresh profiles (drive.ts makes them).

- **Choose files.** `drive.ts` sets `#files` to `verify-report.bin` (300 KB random) and `verify-notes.txt`. `.file-list li` lists 2 files.
- **Seal.** Choose `Seal parcel and create link`. Sender status becomes `waiting-for-recipient` (screenshot `01-sender-waiting`).
- **Reveal the link.** Choose `Show link`. `#link` holds a URL whose fragment is longer than 32 characters.
- **Open the link.** The recipient opens it. Recipient status becomes `reviewing` and the page lists both files (`02-recipient-reviewing`).
- **Accept.** Choose `Accept`. Both sides reach `complete`; the recipient page says "Every file arrived and matched what the sender promised." (`03-recipient-complete`, `04-sender-complete`).
- **Compare.** `fileTransferTest.fileHashes()` equals the SHA-256 of each file the sender chose.
- **Privacy.** `sent.json` lists every URL and frame both browsers sent; none contains the fragment or a file name.
- Command: `bun apps/web/scripts/verify/drive.ts send-receive <origin> <run>/evidence`. Ends with `PASS send-receive`.

## Gotchas

- Locally the direct path usually opens within a second, so this journey proves the direct path, not the relay; `resume-after-drop` covers the relay. The completion report's `Path` row says which carried the records.
- `Accept` may read `Accept and download … on mobile data` when the browser reports a metered connection; match `/^Accept/`.
- Files larger than about 40 MB in total do not fit Playwright's in-memory file input; write them to disk first, as `endToEnd.ts` does.
- Received files live only in the recipient's browser storage; a new profile starts empty.
