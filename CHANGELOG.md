# Changelog

Every release of this repository, newest first, written from the changesets each pull request adds (docs/versioning.md). Each package also keeps its own CHANGELOG.md.

## v0.4.5

### @file-transfer/web 0.4.5

#### Patch Changes

- 5bf09fb: The web app exports its recipient life cycle table so docs/state-machines.md can be generated from it. Nothing changes for people using the app.

### @file-transfer/platform-cloudflare 0.4.5

#### Patch Changes

- @file-transfer/service-quota@0.4.5
  - @file-transfer/service-telemetry@0.4.5

## v0.4.4

### @file-transfer/web 0.4.4

#### Patch Changes

- 733094a: When the browser cannot open storage for a transfer (a full disk, say), the recipient now gives back the storage lock and removes the files it had started, so they no longer linger until the tab closes.

### @file-transfer/platform-cloudflare 0.4.4

#### Patch Changes

- @file-transfer/service-quota@0.4.4
  - @file-transfer/service-telemetry@0.4.4

## v0.4.3

### @file-transfer/web 0.4.3

#### Patch Changes

- a89b246: A recipient that has received every file now stays connected for its whole linger when the sender leaves, so a sender whose connection dropped before it heard "complete" rejoins and finishes instead of waiting forever. The end-to-end suite's clean socket cut now really closes the server's end, which is how this was found.

### @file-transfer/platform-cloudflare 0.4.3

#### Patch Changes

- @file-transfer/service-quota@0.4.3
  - @file-transfer/service-telemetry@0.4.3

## v0.4.2

### @file-transfer/web 0.4.2

#### Patch Changes

- ca3331c: The recipient follows an explicit life cycle. When saving the received files fails, it now tells the sender and frees the storage instead of hanging at 100%; Accept and Decline disappear when a transfer fails while the offer is on screen; and an abort that arrives while storage is opening is no longer overwritten.

### @file-transfer/platform-cloudflare 0.4.2

#### Patch Changes

- @file-transfer/service-quota@0.4.2
  - @file-transfer/service-telemetry@0.4.2

## v0.4.1

### @file-transfer/web 0.4.1

#### Patch Changes

- 410c3e4: A socket whose join the room never answers (opened, then lost on a silent network) is given up after 15 seconds and replaced, instead of waiting minutes for the browser to notice. The room protocol gains one endpoint close code for it, 4100 ("no answer to join"); codes an endpoint adds from now on start at 4100, clear of the room's own. Existing codes keep their meanings, and the room ignores endpoint close codes.
- Updated dependencies [410c3e4]
  - @file-transfer/transport@1.2.0

### @file-transfer/client 0.1.3

#### Patch Changes

- Updated dependencies [410c3e4]
  - @file-transfer/transport@1.2.0

### @file-transfer/transport 1.2.0

#### Minor Changes

- 410c3e4: A socket whose join the room never answers (opened, then lost on a silent network) is given up after 15 seconds and replaced, instead of waiting minutes for the browser to notice. The room protocol gains one endpoint close code for it, 4100 ("no answer to join"); codes an endpoint adds from now on start at 4100, clear of the room's own. Existing codes keep their meanings, and the room ignores endpoint close codes.

### @file-transfer/platform-cloudflare 0.4.1

#### Patch Changes

- Updated dependencies [410c3e4]
  - @file-transfer/transport@1.2.0
  - @file-transfer/service-quota@0.4.1
  - @file-transfer/service-telemetry@0.4.1

## v0.4.0

### @file-transfer/conformance 0.2.0

#### Minor Changes

- 6fb7536: Machines now expose their full state × command matrix, illegal pairs included (`Machine.matrix`, `Machine.toTable`), and `Machine.problems` reports a command whose transitions from one state cannot be told apart. `transitionTableCheck` checks a service against every cell of its machine's table, and the room and relay services declare it as their `follows-machine` guarantee. The relay meter now reports the session's state. `docs/state-machines.md` is generated from the tables.

#### Patch Changes

- Updated dependencies [6fb7536]
  - @file-transfer/machine@0.2.0

### @file-transfer/machine 0.2.0

#### Minor Changes

- 6fb7536: Machines now expose their full state × command matrix, illegal pairs included (`Machine.matrix`, `Machine.toTable`), and `Machine.problems` reports a command whose transitions from one state cannot be told apart. `transitionTableCheck` checks a service against every cell of its machine's table, and the room and relay services declare it as their `follows-machine` guarantee. The relay meter now reports the session's state. `docs/state-machines.md` is generated from the tables.

### @file-transfer/platform-cloudflare 0.4.0

#### Patch Changes

- @file-transfer/service-quota@0.4.0
  - @file-transfer/service-telemetry@0.4.0

### @file-transfer/service-abuse 0.4.0

#### Patch Changes

- Updated dependencies [6fb7536]
  - @file-transfer/conformance@0.2.0

### @file-transfer/service-quota 0.4.0

#### Patch Changes

- Updated dependencies [6fb7536]
  - @file-transfer/conformance@0.2.0

### @file-transfer/service-relay 0.4.0

#### Minor Changes

- 6fb7536: Machines now expose their full state × command matrix, illegal pairs included (`Machine.matrix`, `Machine.toTable`), and `Machine.problems` reports a command whose transitions from one state cannot be told apart. `transitionTableCheck` checks a service against every cell of its machine's table, and the room and relay services declare it as their `follows-machine` guarantee. The relay meter now reports the session's state. `docs/state-machines.md` is generated from the tables.

#### Patch Changes

- Updated dependencies [6fb7536]
  - @file-transfer/machine@0.2.0
  - @file-transfer/conformance@0.2.0

### @file-transfer/service-room 0.4.0

#### Minor Changes

- 6fb7536: Machines now expose their full state × command matrix, illegal pairs included (`Machine.matrix`, `Machine.toTable`), and `Machine.problems` reports a command whose transitions from one state cannot be told apart. `transitionTableCheck` checks a service against every cell of its machine's table, and the room and relay services declare it as their `follows-machine` guarantee. The relay meter now reports the session's state. `docs/state-machines.md` is generated from the tables.

#### Patch Changes

- Updated dependencies [6fb7536]
  - @file-transfer/machine@0.2.0
  - @file-transfer/conformance@0.2.0

### @file-transfer/service-telemetry 0.4.0

#### Patch Changes

- Updated dependencies [6fb7536]
  - @file-transfer/conformance@0.2.0

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
