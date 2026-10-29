# @file-transfer/parcel

## 1.0.1

### Patch Changes

- 7ef4f07: `isWindowsDeviceName` strips trailing spaces with a linear scan instead of the regular expression `/ +$/`, which took quadratic time on a long run of spaces (CodeQL js/polynomial-redos). Results are unchanged, and so is the wire format: within a parcel, segments are at most 255 bytes, so only callers passing longer strings were affected.

## 1.0.0

### Major Changes

- 6b50b85: First versioned release. The product (web client, server node on Cloudflare, in a container or as one executable) starts at 0.1.0: end-to-end encrypted transfers directly between browsers over WebRTC when possible and through the relay otherwise, resume after a dropped connection, previews and renaming, operator limits with a daily relay budget, and opt-in counters. The seam libraries start at 1.0.0: `@file-transfer/parcel` implements the frozen parcel format v1 (docs/parcel.md), and `@file-transfer/transport` the room protocol (docs/protocol.md), whose versions follow docs/versioning.md strictly from here on.
