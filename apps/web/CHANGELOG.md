# @file-transfer/web

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
