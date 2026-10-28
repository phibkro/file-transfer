# 0018 Previews and renaming

Status: accepted (2026-10-29) for items 1 to 5; item 6 proposed, not scheduled.

## Context

The product owner asked for file previews (media and documents) and for renaming files, for both sender and recipient, before and after a transfer. Three constraints shape the answer:

- **Names are part of the contract.** The manifest, with every file name, is sealed into the contract the recipient reviews and pins by digest (parcel.md, "A parcel secret seals exactly one parcel"). A changed name is a changed contract: a new sequence number, a new labelling pass over every byte, and in this app a new link.
- **Received content must not render on the app's origin.** parcel.md (Manifest, Validation) says receivers MUST NOT use `mediaType` to render content on the application's origin. The app's origin holds what matters most: the URL fragment with the link secret, the decrypted files in the origin-private file system, and every open transfer. A hostile file rendered there as a page (HTML, SVG with script) would read all of it.
- **Before Accept, a recipient has only names and sizes.** Nothing of a file's content exists on the recipient's side until the transfer.

Measured on 2026-10-29 with Playwright 1.63 (Chromium 1243, Firefox 1543, WebKit 26.6), a frame with `sandbox="allow-scripts"` and no `allow-same-origin`:

- it reports `window.origin === "null"` and runs its own script;
- it decodes PNG and JPEG images and plays WebM, MP4, MP3 and Ogg from `blob:` URLs it creates itself, in all three engines;
- its module scripts load in CORS mode, so the server must send `Access-Control-Allow-Origin` for them (Chromium refused them without it);
- it cannot show PDF: Chromium logs "Failed to load ... as a plugin, because the frame into which the plugin is loading is sandboxed", and Firefox and WebKit render nothing for `<iframe>`, `<embed>` or `<object>`;
- WebKit's media controls need inline styles (`style-src 'unsafe-inline'`), which is acceptable inside the frame only.

## Decision

1. **Senders rename before sealing, never after.** Each file in the selection can be renamed until "Seal parcel and create link". A rename is checked at once against the parcel's name profile and for collisions (`renameProblem` in `apps/web/src/selection.ts`), and a refusal is shown in place. Sealing locks names and files; the button and a note under it say so. After sealing, "Send other files" opens a new parcel in a new tab, so the sealed one keeps serving its recipient.
2. **Recipients rename only what they save.** Before and after Accept, a recipient can change the name each file is saved under. It is a local choice: the contract, the sender and the bytes are unaffected, which the end-to-end check confirms by hashing renamed files. Save links and Save all use the new names, which pass the same rules.
3. **Previews render only in an opaque-origin frame.** `preview.html` loads in an `<iframe sandbox="allow-scripts">`, and its response carries `Content-Security-Policy: sandbox allow-scripts; ...` (`apps/web/public/_headers`), so the page has an opaque origin even when opened on its own. Its script refuses to run with a real origin. The app gives it the file as a `Blob` through `postMessage`; the frame cannot fetch anything (`default-src 'none'`).
4. **The bytes decide, from an allowlist.** The first 4 KiB of a file decide whether it previews and how (`apps/web/src/sniff.ts`): PNG, JPEG, GIF, WebP and AVIF as images; MP4, QuickTime and WebM as video; MP3, M4A, Ogg, FLAC and WAV as audio; anything else that is valid UTF-8 without NUL bytes as text (at most 64 KiB, shown through `textContent`). Names and `mediaType` are never consulted. The preview's `Blob` gets the sniffed type, so the browser never guesses. HTML, SVG and XML are never rendered as markup; at most they show as text.
5. **Senders preview before sealing; recipients after verification.** A recipient previews a file only once every record has verified and the file is committed, so a preview never shows content that failed authentication.
6. **Proposed: previews before Accept as a preview parcel.** If a sender opts in, the app makes small previews (an image scaled to 256 pixels, a video's first frame, the first lines of text), seals them as their own small parcel under the room's next sequence number, and offers that contract first. The recipient opens it like any parcel and shows its contents in the preview frame next to the main offer. This needs no change to parcel v1 (a room is already a sequence of contracts, ADR 0012), but needs the app to handle more than one parcel per room. It discloses a little content before Accept, which is why it is the sender's choice.

## Consequences

- **PDF and office documents have no preview yet.** PDF needs a renderer inside the frame; pdf.js (Apache-2.0, compatible with AGPL-3.0) is the proven option. It would run with a worker created from a `blob:` URL (the frame's opaque origin cannot start a worker from the server's URL) and with `isEvalSupported: false` (CVE-2024-4367 abused its font evaluation). Word and Excel files would each need a further library; not planned.
- **The frame shares a process with the app in some browsers.** An opaque origin stops script and storage access, but a memory-safety bug in a decoder could still reach the renderer process the app uses, unless the browser isolates sandboxed frames in their own process. Whether each browser does so is not verified here. A preview page on a separate registrable domain (as `googleusercontent.com` serves Google's) would put previews in another process for certain; that is the next step if previews of untrusted content become common.
- **Static assets carry `Access-Control-Allow-Origin: *`.** The frame's scripts need it. The assets are public code, so reading them from another origin reveals nothing.
- **Sender-side previews run the same path.** A sender's own files can be hostile too (a file received elsewhere), so they get the same frame and allowlist.
