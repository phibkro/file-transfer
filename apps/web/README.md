# apps/web

Pocketdrop provides Quick Share, recipient pages, the Local Library, operator controls and information pages. Foldkit and Foldkit UI own the interface. Tailwind CSS supplies the shared theme and styles. Vite+ builds static assets for either platform. See [ADR 0026](../../docs/decisions/0026-foldkit-browser-ui.md) and [the component decisions](../../docs/specs/foldkit-ui-component-adoption.md).

## Quick Share

- `/` combines Quick Share and the Local Library in one workspace. Section links, the brand link and browser history retain active transfers. Choose files in batches, rename or preview them, then seal and share the link. Quick Share does not require Library opt-in.
- The Receive tab opens a valid recipient link from this instance. It rejects other origins, URL credentials, query strings and malformed keys. Open a link to another instance directly in your browser. Link inputs and navigation arguments remain redacted.
- `/r/<room>#<secret>` reviews an offer before accepting bytes. Accepted files are written provisionally to the browser's origin-private filesystem and offered for saving only after verification. Recipients can change local save names, preview verified files, save individually or together, and remove received files.
- Share controls reveal the secret, copy the link or generate its QR code only through explicit actions. Servers receive ciphertext, not keys, fragments, filenames or plaintext. Preview content stays in an opaque sandbox with the existing restrictive CSP and byte-sniff allowlist.
- Received plaintext belongs to the receiving page. Web Locks protect active transfers from other tabs' sweeps; page startup removes abandoned output. The leave guard warns about active transfers or unsaved received files. Settings distinguishes received output from the Library catalog.

## Local Library

`/library` opens the same workspace at its on-device catalog. It does not provide file storage or cloud synchronization.

- Every browser has a nondeletable **My files** collection. Its membership derives from indexed entries rather than a separately stored roster.
- The remembering checkbox is explicit and off by default. Opting in permits storing metadata, local content fingerprints, collection membership and supported native file handles in IndexedDB. File bytes are not copied into IndexedDB, OPFS or cloud storage by indexing.
- Ordinary file choosing and File Drop work without File System Access support. They retain a captured File for the current page only. After editing an original or reopening the page, reconnect by reselecting it. Supported browsers can optionally remember durable handles, subject to permission.
- Create an empty named collection, then use Add files to index originals. Search and collection filters stay local. Manage reconnects or forgets an entry. Selection controls appear only when files are selected. Share opens version review before Quick Share. Selected-file reviews and full-collection reviews remain distinct.
- Local edits affect future shares, not an existing sealed parcel. Reconnection preserves the previously approved fingerprint. Review checks supplied current bytes, including changes with the same size and modification time; changed versions need explicit approval. Missing originals, denied access and stale cross-tab approvals block the operation rather than silently omitting files.
- Turning remembering off forgets catalog metadata, references and named collections, never original files. My files remains available.

Preview reads the current original locally without approving a changed version or starting a share. Closing returns focus to its triggering control. Details and reload remain in How it works rather than the main toolbar. Initial catalog loading is explicit; startup navigation waits for it, and the hero image reserves its intrinsic dimensions to avoid reload layout shifts.
Cloud storage is not implemented. Service-provided cloud storage requires an account and Premium when introduced. Configuring a self-hosted cloud server does not require Premium; indexing local files does not upload them.

## Shared theme

[style.css](src/styles/theme.css) is the authoritative global stylesheet. Its `:root` defines semantic background/foreground pairs, cards, primary actions, muted content, borders, focus rings, radii, fonts and chart colors. Tailwind's `@theme inline` maps those variables to utilities. Components use semantic tokens instead of separate color palettes. The convention follows [shadcn theming](https://ui.shadcn.com/docs/theming), without React or shadcn component dependencies.

Settings offers Light, Dark and System appearance, stored only on this device. System follows the operating-system theme live. The shared layout applies a validated saved choice before paint through a CSP-hashed startup script, including recipient, operator and static information pages. The opaque preview receives the choice over its validated channel rather than accessing storage.
The operator-supplied design provides the Pocketdrop identity and artwork. Its provenance is in [research.md](../../docs/research.md#pocketdrop-design-reference). Its demo transfer storage, sample files, history and expiry controls are not part of this application. Preview content remains isolated in its sandbox. QR black and white modules are scanner requirements, not theme colors.

## File previews

Quick Share, received files and indexed local files share the same preview Submodel. Content is classified by bytes, not names or claimed MIME types. PDF.js renders PDFs as bounded canvases inside the opaque sandbox; document actions, annotations, XFA and external resource fetching are disabled. Page controls reuse the loaded document. Clear, close and unmount cancel work and destroy the document. PDFs over 25 MiB are not previewed; pages are bounded to 2048 pixels per edge and four million pixels.

The bundled main-thread PDF worker avoids a worker or network exception in CSP. Standard fonts and CMaps are inlined from the pinned PDF.js package. Regenerate their manifest with `bun apps/web/scripts/generatePdfResources.ts`; `bun run check:pdf-resources` detects drift and is part of `bun run check`. Large or complex PDFs can still take time on the main thread. Unsupported or malformed files show an unavailable-preview message instead of executing active content.

## Implementation boundaries

- [entry.ts](src/app/entry.ts) owns browser startup and address capture. [main.ts](src/app/main.ts) composes page Submodels, settings, summaries and owned subscriptions.
- The sender, recipient, Library and operator directories contain Schema-backed Models and Messages, pure update/view functions, and Foldkit lifecycle primitives. [ui/](src/ui/) contains shared controls.
- [sender.ts](src/features/quick-share/session.ts), [recipient.ts](src/features/receive/session.ts), [connection.ts](src/capabilities/connection/connection.ts), [direct.ts](src/capabilities/connection/direct.ts) and [storage.ts](src/capabilities/transfer/storage.ts) provide transfer and native browser capabilities. Wire decoding stays Valibot-based; the parcel format is unchanged.
- [catalog](../../libraries/catalog/src/index.ts) owns portable metadata, collection rules, consent epochs, revision checks and approval decisions. Its reference Layer uses in-memory state.
- [localLibrary.ts](src/capabilities/catalog/browser.ts) implements those decisions inside native IndexedDB transactions. It owns file handles, transient Files, source resolution and fingerprint reads.
- Catalog snapshots contain metadata and opaque source strings, never native Files or handles. The browser adapter returns committed snapshots and publishes source capabilities only after commit.
- [privateValue.ts](src/ui/privateValue.ts) gives sensitive state a redacted, non-restorable development JSON codec. Names, keys, fragments, native Files/handles and preview payloads must not enter preservation or diagnostic messages as plaintext.
- [site/](src/site/) and [layout.ts](scripts/layout.ts) render shared chrome and static information pages through Foldkit. Information pages remain useful without JavaScript. uPlot is isolated to the operator page and owned by an element Mount.

## Development and AI tools

Use the pinned toolchain from the repository root:

```sh
nix-shell shell.nix
bun install --frozen-lockfile
# Start the Cloudflare room platform on port 8787 in another terminal.
bun run --cwd apps/web dev
```

The Vite plugin supplies development preservation and the local DevTools bridge. The repository's `.mcp.json` launches the installed Foldkit DevTools MCP server through the pinned shell. Runtime discovery requires a development app. The official Foldkit Oxlint recommended rules run inside the existing root Vite+ lint configuration. Package manifests and the lockfile define dependency versions.

## Verification

Use [verify-file-transfer](../../.claude/skills/verify-file-transfer/SKILL.md) and its feature map. Launch with an explicit stable directory outside the checkout. A default directory under a short-lived nix-shell TMPDIR disappears when the shell exits:

```sh
nix-shell shell.nix --run 'bun apps/web/scripts/verify/launch.ts /tmp/file-transfer-verification'
```

Doctor checks the revision and [snapshot fingerprint](scripts/verify/snapshot.ts), including tracked changes and untracked file contents. Untracked symlinks fingerprint their targets, not external file contents. The launcher refuses an instance if source changes while it builds or copies assets. After edits, stop and relaunch the instance. Do not drive stale assets. On NixOS, select a system browser through `E2E_BROWSER_EXECUTABLE_PATH`. The default remains Playwright's bundled browser. The deeper `scripts/endToEnd.ts` suites cover completion, lifecycle, faults, network emulation and large transfers.

Native transfer reports can arrive before Foldkit paints. Browser lifecycle checks wait for the rendered controls they assert, not only the native status hook.

The read-only `window.fileTransferTest` hook exposes transfer status/progress, failure information, path and received-file hashes. It is evidence for browser-driven actions, not an API for causing state transitions.
