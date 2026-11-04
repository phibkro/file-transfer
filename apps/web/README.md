# apps/web

Quick Share, recipient pages, the Local Library, operator controls and information pages. The UI uses Foldkit and Foldkit UI; Vite+ builds static assets served by either platform. See [ADR 0026](../../docs/decisions/0026-foldkit-browser-ui.md) for the framework boundary and [the component decisions](../../docs/specs/foldkit-ui-component-adoption.md) for toolkit adoption.

## Quick Share

- `/` chooses or drops files in batches. Rename or preview originals before sealing. Sealing fixes names and contents for that parcel; share its link and keep the tab open until the recipient finishes. Quick Share does not require remembering files in the Library.
- `/r/<room>#<secret>` reviews an offer before accepting bytes. Accepted files are written provisionally to the browser's origin-private filesystem and offered for saving only after verification. Recipients can change local save names, preview verified files, save individually or together, and remove received files.
- Share controls reveal the secret, copy the link or generate its QR code only through explicit actions. Servers receive ciphertext, not keys, fragments, filenames or plaintext. Preview content stays in an opaque sandbox with the existing restrictive CSP and byte-sniff allowlist.
- Received plaintext belongs to the receiving page. Web Locks protect active transfers from other tabs' sweeps; page startup removes abandoned output. The leave guard warns about active transfers or unsaved received files. Browser settings distinguish received output from the Library catalog.

## Local Library

`/library` is an on-device catalog, not file storage or cloud synchronization.

- Every browser has a nondeletable **My files** collection. Its membership derives from indexed entries rather than a separately stored roster.
- Remembering is explicit and off by default. Opting in permits storing metadata, local content fingerprints, collection membership and supported native file handles in IndexedDB. File bytes are not copied into IndexedDB, OPFS or cloud storage by indexing.
- Ordinary file choosing and File Drop work without File System Access support. They retain a captured File for the current page only. After editing an original or reopening the page, reconnect by reselecting it. Supported browsers can optionally remember durable handles, subject to permission.
- Create an empty named collection before selecting files, then add or remove indexed members. Review current versions before sharing the selection or collection through Quick Share.
- Local edits affect future shares, not an existing sealed parcel. Reconnection preserves the previously approved fingerprint. Review checks supplied current bytes, including changes with the same size and modification time; changed versions need explicit approval. Missing originals, denied access and stale cross-tab approvals block the operation rather than silently omitting files.
- Turning remembering off forgets catalog metadata, references and named collections, never original files. My files remains available.

Cloud storage is not implemented. Service-provided cloud storage requires an account and Premium when introduced. Configuring a self-hosted cloud server does not require Premium; indexing local files does not upload them.

## Implementation boundaries

- [entry.ts](src/entry.ts) owns browser startup and address capture. [main.ts](src/main.ts) composes page Submodels, settings, summaries and owned subscriptions.
- The sender, recipient, Library and operator directories contain Schema-backed Models and Messages, pure update/view functions, and Foldkit lifecycle primitives. [ui/](src/ui/) contains shared controls.
- [sender.ts](src/sender.ts), [recipient.ts](src/recipient.ts), [connection.ts](src/connection.ts), [direct.ts](src/direct.ts) and [storage.ts](src/storage.ts) provide transfer and native browser capabilities. Wire decoding stays Valibot-based; the parcel format is unchanged.
- [localLibrary.ts](src/localLibrary.ts) owns catalog transactions, consent/revision fences, references and local version review.
- [privateValue.ts](src/privateValue.ts) gives sensitive state a redacted, non-restorable development JSON codec. Names, keys, fragments, native Files/handles and preview payloads must not enter preservation or diagnostic messages as plaintext.
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

Doctor checks the recorded revision and dirty-tree digest. After edits, stop and relaunch the instance. Do not drive stale assets. On NixOS, select a system browser through `E2E_BROWSER_EXECUTABLE_PATH`. The default remains Playwright's bundled browser. The deeper `scripts/endToEnd.ts` suites cover completion, lifecycle, faults, network emulation and large transfers.

The read-only `window.fileTransferTest` hook exposes transfer status/progress, failure information, path and received-file hashes. It is evidence for browser-driven actions, not an API for causing state transitions.
