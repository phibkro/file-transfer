# @file-transfer/transport

## 1.1.0

### Minor Changes

- cc21d36: A socket that goes silent without closing (a NAT forgetting the connection, a phone changing networks) no longer stalls a transfer: rooms now answer liveness pings and say so in `joined` (`answersPings`), and endpoints ping after 10 seconds of silence and rejoin after 20, resuming from what is missing. Before, such a transfer could hang until the browser's TCP timeout, many minutes later. Older rooms and endpoints keep working as before (docs/protocol.md, "Liveness").

## 1.0.0

### Major Changes

- 6b50b85: First versioned release. The product (web client, server node on Cloudflare, in a container or as one executable) starts at 0.1.0: end-to-end encrypted transfers directly between browsers over WebRTC when possible and through the relay otherwise, resume after a dropped connection, previews and renaming, operator limits with a daily relay budget, and opt-in counters. The seam libraries start at 1.0.0: `@file-transfer/parcel` implements the frozen parcel format v1 (docs/parcel.md), and `@file-transfer/transport` the room protocol (docs/protocol.md), whose versions follow docs/versioning.md strictly from here on.
