# Local Library

The local Library indexes file metadata after opt-in. Collections group references without uploading or copying file contents. A share requires review of current versions.

## Sub-features

- `My files` exists before opt-in and includes every indexed file.
- An empty collection can exist without any indexed files.
- A collection can be reviewed and shared through Quick Share.
- Search filters indexed entries locally without changing collection membership.
- Workspace section, brand and history navigation retain a live sender.
- Reconnection preserves the approved baseline. Changed bytes require a new review, even with the same size and modification time.
- Opting out forgets the catalog but retains `My files`.

## How to get to it (user POV)

- Open `Library` and turn on `Remember files on this device`.
- Choose `New collection` to create an empty collection. Use `Add to catalog` to choose files, then select and add members.
- Review the collection and approve the current versions. Quick Share seals the approved files.
- Reopen the Library, choose `Manage <filename>`, then `Reconnect <filename>` before the next review.
- Turn remembering off and confirm forgetting to clear the catalog.

## Driving it with drive.ts

Preconditions:

- Doctor passes for the origin.
- Two fresh profiles are available. The driver creates them.

- **Run the journey.** `bun apps/web/scripts/verify/drive.ts library <origin> <run>/evidence`. It ends with `PASS library`.
- **Default and collection.** The driver observes `My files` with remembering off. It opts in and creates an empty collection.
- **Index and share.** The driver opens catalog dialogs and indexes two files. Search filters them locally. Only one becomes a collection member and reaches the recipient.
- **Navigate while sharing.** Library, brand, Back and Forward navigation retain the sender and the same document.
- **Reconnect and review.** After reopening, review fails without the original and creates no room. The driver reconnects different bytes with the same name, size, and modification time. The changed review appears and the prior approval remains until explicit approval.
- **Resend and opt out.** The recipient receives the modified bytes. Opt-out leaves no catalog files or collections and retains `My files`.
- **Privacy.** The driver inspects IndexedDB read-only for metadata and stored blobs. `sent.json` covers observed URLs, bodies, and socket frames during indexing and both shares.

## Gotchas

- Standard file input captures a File for the page. Reconnect after reopening or editing an original.
- The driver supplies deterministic bytes and modification time at the DOM file-input boundary. It does not seed IndexedDB or call application internals.
- `sent.json` cannot observe bodies from workers, new `about:blank` frames, or streams. It redacts secrets and file names before writing evidence.
- The browser executable override and stable run-directory instructions are in the [verification skill](../SKILL.md).
