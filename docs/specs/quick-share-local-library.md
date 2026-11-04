# Quick Share and Local Library

## Goal

Keep the existing live encrypted transfer journey under the name Quick Share. Let a sender index original files in a device-local Library, browse them, group them into reusable collections, and share a collection again.

## Constraints and decisions

- Local Library is free and requires no account. Remembering files is explicit opt-in, default off. Store only file handles, names, sizes, modification times, content fingerprints and collection membership locally, never file contents and never a server-side catalog.
- Collections reference original files. Edits to original files affect future shares. State this before opt-in and beside sharing actions. Adding/indexing files is distinct from uploading to storage.
- Consent and catalog edits are atomic across tabs. Opt-out forgets the catalog and collections, never original files. Clearing browser data also forgets the catalog. File handles may require renewed permission; missing files can be reconnected. Unsupported browsers use ordinary Quick Share with reselection, never a silent file-copy fallback.
- Indexing establishes a local content fingerprint. Before every share, read and fingerprint originals again, show changed versus unchanged versions, and require explicit Share current versions approval. The baseline means indexed or last approved, not last successfully delivered. No continuous background monitoring is promised. Reconnecting an original requires explicit replacement confirmation.
- Consent epochs invalidate work begun before opt-out, including off/on cycles. File and collection revisions reject stale approvals and membership changes. Library navigation and controls are disabled during local asynchronous work to prevent stale completion from reviving an obsolete action.
- Quick Share does not automatically remember files. Sending indexed files uses the existing encryption and room protocol with fresh keys and a fresh room each time.
- Preserve recipient links and the frozen parcel protocol.
- Use the current plain DOM application and existing sender, rather than introduce a second frontend framework.
- Cloud Library is unavailable in this delivery. Hosted cloud storage will require an account and Premium, with no free hosted storage tier. Configurable self-hosted storage will not require a paid subscription. All server storage must remain ciphertext-only.

## Journey and falsifiers

1. Open Quick Share and choose files for a live transfer as before.
2. Open Library, On this device. Confirm remembering is off. Opt in, add file references, browse names and recorded sizes. No room request, upload, or copy of file bytes occurs.
3. Select files, name and save a collection. Reload: file handles, metadata and collection membership survive.
4. Browse a collection, add or remove members, and share it through Quick Share. Receive the original bytes. Edit an original, reload and share again with a different room and link: receive the edited bytes. The edit behavior is disclosed before sharing.
5. Delete a collection without deleting its originals; forget an indexed file with all its memberships in one transaction. Opt out: forget the catalog and reject stale-tab writes. Errors remain visible and failed writes are not reported as saved.
6. Cloud presentation states unavailability and the hosted/self-hosted policy; offers no nonfunctional upload or subscription controls.
7. Browser storage limitations are visible. Narrow screens and keyboard controls remain usable.

## Verification

Observed on 2026-11-04:

- Chromium UI against the real local Worker and room Durable Object: default-off consent, native file-handle structured-clone persistence across reload, reusable collection, explicit review and approval, and original/edited resend with different links and exact received SHA-256 values.
- Catalog record inspection: handles plus metadata/fingerprints only, no Blob or File bytes. Indexing/collection creation and rejected sharing paths made no room requests.
- Fingerprint mismatch detected a same-size edit with matching catalog/current modification timestamps (timestamp preservation simulated by aligning catalog metadata after a native file edit).
- Cross-tab membership changes blocked approval. Work pending in a picker was rejected after a second tab opted out then back in. Opt-out cleared files and collections. A deleted native source handle blocked the entire selection before room creation.
- Confirmed reconnect replacement, adding/removing collection members, forgetting an indexed file, and deleting a collection while retaining its original file. Simulated absent picker/handle APIs: Quick Share still rendered and Library disabled indexing with an explicit explanation, without page errors.
- Cloud policy visible and explicitly unavailable; 390px viewport without horizontal overflow; axe-core reported zero violations, one incomplete check.
- Repository check: format, lint, types, module graph and Effect enforcement clean; 180 tests across 16 files passed. Production web build passed.

Limit: browser automation cannot drive the native File System Access picker. Smoke supplied real browser-native OPFS handles through a substituted picker, then exercised real IndexedDB, native file reads/edits and the real transfer backend. Native disk picker selection and renewed OS-file permission prompts still require manual browser verification. No cloud service or cross-browser compatibility claim is made.

## Revisions

- 2026-11-04: User selected Local Library now; cloud implementation remains deferred, with policy recorded here and in the product plan.
- 2026-11-04: User changed storage to opt-in metadata/file-handle indexing, not file copies, and required explicit disclosure that original edits affect future shares. Updated the contract and implementation before runtime verification.
- 2026-11-04: User approved change-review policy. Added local chunked content fingerprints, explicit version approval, replacement confirmation, and cross-tab consent/version conflict rejection. Kept the existing parcel cryptography and wire format unchanged.
