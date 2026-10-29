# Changelog

Every release of this repository, newest first, written from the changesets each pull request adds (docs/versioning.md). Each package also keeps its own CHANGELOG.md.

## v0.3.0

### @file-transfer/web 0.3.0

#### Minor Changes

- a076e33: The completion report says when the direct path opened and how often it dropped back to the relay, and what network the browser reports (Chromium-based browsers only), for testing on real networks with docs/network-testing.md.

### @file-transfer/platform-cloudflare 0.3.0

#### Patch Changes

- @file-transfer/service-quota@0.3.0
  - @file-transfer/service-telemetry@0.3.0

## v0.2.0

### @file-transfer/web 0.2.0

#### Minor Changes

- cc21d36: A socket that goes silent without closing (a NAT forgetting the connection, a phone changing networks) no longer stalls a transfer: rooms now answer liveness pings and say so in `joined` (`answersPings`), and endpoints ping after 10 seconds of silence and rejoin after 20, resuming from what is missing. Before, such a transfer could hang until the browser's TCP timeout, many minutes later. Older rooms and endpoints keep working as before (docs/protocol.md, "Liveness").

#### Patch Changes

- Updated dependencies [cc21d36]
  - @file-transfer/transport@1.1.0

### @file-transfer/client 0.1.2

#### Patch Changes

- Updated dependencies [cc21d36]
  - @file-transfer/transport@1.1.0

### @file-transfer/transport 1.1.0

#### Minor Changes

- cc21d36: A socket that goes silent without closing (a NAT forgetting the connection, a phone changing networks) no longer stalls a transfer: rooms now answer liveness pings and say so in `joined` (`answersPings`), and endpoints ping after 10 seconds of silence and rejoin after 20, resuming from what is missing. Before, such a transfer could hang until the browser's TCP timeout, many minutes later. Older rooms and endpoints keep working as before (docs/protocol.md, "Liveness").

### @file-transfer/platform-cloudflare 0.2.0

#### Minor Changes

- cc21d36: A socket that goes silent without closing (a NAT forgetting the connection, a phone changing networks) no longer stalls a transfer: rooms now answer liveness pings and say so in `joined` (`answersPings`), and endpoints ping after 10 seconds of silence and rejoin after 20, resuming from what is missing. Before, such a transfer could hang until the browser's TCP timeout, many minutes later. Older rooms and endpoints keep working as before (docs/protocol.md, "Liveness").

#### Patch Changes

- Updated dependencies [cc21d36]
  - @file-transfer/transport@1.1.0
  - @file-transfer/service-quota@0.2.0
  - @file-transfer/service-telemetry@0.2.0

## v0.1.1

### @file-transfer/web 0.1.1

#### Patch Changes

- Updated dependencies [7ef4f07]
  - @file-transfer/parcel@1.0.1

### @file-transfer/client 0.1.1

#### Patch Changes

- Updated dependencies [7ef4f07]
  - @file-transfer/parcel@1.0.1

### @file-transfer/parcel 1.0.1

#### Patch Changes

- 7ef4f07: `isWindowsDeviceName` strips trailing spaces with a linear scan instead of the regular expression `/ +$/`, which took quadratic time on a long run of spaces (CodeQL js/polynomial-redos). Results are unchanged, and so is the wire format: within a parcel, segments are at most 255 bytes, so only callers passing longer strings were affected.

### @file-transfer/platform-cloudflare 0.1.1

#### Patch Changes

- Updated dependencies [7ef4f07]
  - @file-transfer/parcel@1.0.1
  - @file-transfer/service-quota@0.1.1
  - @file-transfer/service-telemetry@0.1.1

### @file-transfer/service-room 0.1.1

#### Patch Changes

- Updated dependencies [7ef4f07]
  - @file-transfer/parcel@1.0.1

## v0.1.0

### @file-transfer/web 0.1.0

#### Minor Changes

- 6b50b85: First versioned release. The product (web client, server node on Cloudflare, in a container or as one executable) starts at 0.1.0: end-to-end encrypted transfers directly between browsers over WebRTC when possible and through the relay otherwise, resume after a dropped connection, previews and renaming, operator limits with a daily relay budget, and opt-in counters. The seam libraries start at 1.0.0: `@file-transfer/parcel` implements the frozen parcel format v1 (docs/parcel.md), and `@file-transfer/transport` the room protocol (docs/protocol.md), whose versions follow docs/versioning.md strictly from here on.

#### Patch Changes

- Updated dependencies [6b50b85]
  - @file-transfer/parcel@1.0.0
  - @file-transfer/transport@1.0.0

### @file-transfer/client 0.1.0

#### Minor Changes

- 6b50b85: First versioned release. The product (web client, server node on Cloudflare, in a container or as one executable) starts at 0.1.0: end-to-end encrypted transfers directly between browsers over WebRTC when possible and through the relay otherwise, resume after a dropped connection, previews and renaming, operator limits with a daily relay budget, and opt-in counters. The seam libraries start at 1.0.0: `@file-transfer/parcel` implements the frozen parcel format v1 (docs/parcel.md), and `@file-transfer/transport` the room protocol (docs/protocol.md), whose versions follow docs/versioning.md strictly from here on.

#### Patch Changes

- Updated dependencies [6b50b85]
  - @file-transfer/parcel@1.0.0
  - @file-transfer/transport@1.0.0
  - @file-transfer/sink@0.1.0

### @file-transfer/conformance 0.1.0

#### Minor Changes

- 6b50b85: First versioned release. The product (web client, server node on Cloudflare, in a container or as one executable) starts at 0.1.0: end-to-end encrypted transfers directly between browsers over WebRTC when possible and through the relay otherwise, resume after a dropped connection, previews and renaming, operator limits with a daily relay budget, and opt-in counters. The seam libraries start at 1.0.0: `@file-transfer/parcel` implements the frozen parcel format v1 (docs/parcel.md), and `@file-transfer/transport` the room protocol (docs/protocol.md), whose versions follow docs/versioning.md strictly from here on.

### @file-transfer/machine 0.1.0

#### Minor Changes

- 6b50b85: First versioned release. The product (web client, server node on Cloudflare, in a container or as one executable) starts at 0.1.0: end-to-end encrypted transfers directly between browsers over WebRTC when possible and through the relay otherwise, resume after a dropped connection, previews and renaming, operator limits with a daily relay budget, and opt-in counters. The seam libraries start at 1.0.0: `@file-transfer/parcel` implements the frozen parcel format v1 (docs/parcel.md), and `@file-transfer/transport` the room protocol (docs/protocol.md), whose versions follow docs/versioning.md strictly from here on.

### @file-transfer/parcel 1.0.0

#### Major Changes

- 6b50b85: First versioned release. The product (web client, server node on Cloudflare, in a container or as one executable) starts at 0.1.0: end-to-end encrypted transfers directly between browsers over WebRTC when possible and through the relay otherwise, resume after a dropped connection, previews and renaming, operator limits with a daily relay budget, and opt-in counters. The seam libraries start at 1.0.0: `@file-transfer/parcel` implements the frozen parcel format v1 (docs/parcel.md), and `@file-transfer/transport` the room protocol (docs/protocol.md), whose versions follow docs/versioning.md strictly from here on.

### @file-transfer/sink 0.1.0

#### Minor Changes

- 6b50b85: First versioned release. The product (web client, server node on Cloudflare, in a container or as one executable) starts at 0.1.0: end-to-end encrypted transfers directly between browsers over WebRTC when possible and through the relay otherwise, resume after a dropped connection, previews and renaming, operator limits with a daily relay budget, and opt-in counters. The seam libraries start at 1.0.0: `@file-transfer/parcel` implements the frozen parcel format v1 (docs/parcel.md), and `@file-transfer/transport` the room protocol (docs/protocol.md), whose versions follow docs/versioning.md strictly from here on.

### @file-transfer/transport 1.0.0

#### Major Changes

- 6b50b85: First versioned release. The product (web client, server node on Cloudflare, in a container or as one executable) starts at 0.1.0: end-to-end encrypted transfers directly between browsers over WebRTC when possible and through the relay otherwise, resume after a dropped connection, previews and renaming, operator limits with a daily relay budget, and opt-in counters. The seam libraries start at 1.0.0: `@file-transfer/parcel` implements the frozen parcel format v1 (docs/parcel.md), and `@file-transfer/transport` the room protocol (docs/protocol.md), whose versions follow docs/versioning.md strictly from here on.

### @file-transfer/platform-cloudflare 0.1.0

#### Patch Changes

- Updated dependencies [6b50b85]
  - @file-transfer/parcel@1.0.0
  - @file-transfer/transport@1.0.0
  - @file-transfer/service-quota@0.1.0
  - @file-transfer/service-telemetry@0.1.0

### @file-transfer/service-abuse 0.1.0

#### Patch Changes

- Updated dependencies [6b50b85]
  - @file-transfer/conformance@0.1.0

### @file-transfer/service-quota 0.1.0

#### Patch Changes

- Updated dependencies [6b50b85]
  - @file-transfer/conformance@0.1.0

### @file-transfer/service-relay 0.1.0

#### Patch Changes

- Updated dependencies [6b50b85]
  - @file-transfer/machine@0.1.0
  - @file-transfer/conformance@0.1.0

### @file-transfer/service-room 0.1.0

#### Patch Changes

- Updated dependencies [6b50b85]
  - @file-transfer/parcel@1.0.0
  - @file-transfer/machine@0.1.0
  - @file-transfer/conformance@0.1.0

### @file-transfer/service-telemetry 0.1.0

#### Patch Changes

- Updated dependencies [6b50b85]
  - @file-transfer/conformance@0.1.0
