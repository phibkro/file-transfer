# @file-transfer/web

## 0.5.3

No changes in this release.

## 0.5.2

### Patch Changes

- 28d84be: When a transfer stops right after its files were opened for writing, the recipient now retries removing the half-written folder for a moment instead of leaving it until the next visit (Chromium briefly refuses the removal). The browser suite also patches storage on prototypes, which WebKit keeps, so its storage checks no longer fail at random there.

## 0.5.1

### Patch Changes

- e3d0bbf: The web app reads its own address in one module, and a lint rule stops any other code from reading the URL fragment that holds the link secret. Nothing changes for people using the app.

## 0.5.0

No changes in this release.

## 0.4.5

### Patch Changes

- 5bf09fb: The web app exports its recipient life cycle table so docs/state-machines.md can be generated from it. Nothing changes for people using the app.

## 0.4.4

### Patch Changes

- 733094a: When the browser cannot open storage for a transfer (a full disk, say), the recipient now gives back the storage lock and removes the files it had started, so they no longer linger until the tab closes.

## 0.4.3

### Patch Changes

- a89b246: A recipient that has received every file now stays connected for its whole linger when the sender leaves, so a sender whose connection dropped before it heard "complete" rejoins and finishes instead of waiting forever. The end-to-end suite's clean socket cut now really closes the server's end, which is how this was found.

## 0.4.2

### Patch Changes

- ca3331c: The recipient follows an explicit life cycle. When saving the received files fails, it now tells the sender and frees the storage instead of hanging at 100%; Accept and Decline disappear when a transfer fails while the offer is on screen; and an abort that arrives while storage is opening is no longer overwritten.

## 0.4.1

### Patch Changes

- 410c3e4: A socket whose join the room never answers (opened, then lost on a silent network) is given up after 15 seconds and replaced, instead of waiting minutes for the browser to notice. The room protocol gains one endpoint close code for it, 4100 ("no answer to join"); codes an endpoint adds from now on start at 4100, clear of the room's own. Existing codes keep their meanings, and the room ignores endpoint close codes.
- Updated dependencies [410c3e4]
  - @file-transfer/transport@1.2.0

## 0.4.0

No changes in this release.

## 0.3.0

### Minor Changes

- a076e33: The completion report says when the direct path opened and how often it dropped back to the relay, and what network the browser reports (Chromium-based browsers only), for testing on real networks with docs/network-testing.md.

## 0.2.0

### Minor Changes

- cc21d36: A socket that goes silent without closing (a NAT forgetting the connection, a phone changing networks) no longer stalls a transfer: rooms now answer liveness pings and say so in `joined` (`answersPings`), and endpoints ping after 10 seconds of silence and rejoin after 20, resuming from what is missing. Before, such a transfer could hang until the browser's TCP timeout, many minutes later. Older rooms and endpoints keep working as before (docs/protocol.md, "Liveness").

### Patch Changes

- Updated dependencies [cc21d36]
  - @file-transfer/transport@1.1.0

## 0.1.1

### Patch Changes

- Updated dependencies [7ef4f07]
  - @file-transfer/parcel@1.0.1

## 0.1.0

### Minor Changes

- 6b50b85: First versioned release. The product (web client, server node on Cloudflare, in a container or as one executable) starts at 0.1.0: end-to-end encrypted transfers directly between browsers over WebRTC when possible and through the relay otherwise, resume after a dropped connection, previews and renaming, operator limits with a daily relay budget, and opt-in counters. The seam libraries start at 1.0.0: `@file-transfer/parcel` implements the frozen parcel format v1 (docs/parcel.md), and `@file-transfer/transport` the room protocol (docs/protocol.md), whose versions follow docs/versioning.md strictly from here on.

### Patch Changes

- Updated dependencies [6b50b85]
  - @file-transfer/parcel@1.0.0
  - @file-transfer/transport@1.0.0
