# @file-transfer/machine

## 0.2.0

### Minor Changes

- 6fb7536: Machines now expose their full state × command matrix, illegal pairs included (`Machine.matrix`, `Machine.toTable`), and `Machine.problems` reports a command whose transitions from one state cannot be told apart. `transitionTableCheck` checks a service against every cell of its machine's table, and the room and relay services declare it as their `follows-machine` guarantee. The relay meter now reports the session's state. `docs/state-machines.md` is generated from the tables.

## 0.1.0

### Minor Changes

- 6b50b85: First versioned release. The product (web client, server node on Cloudflare, in a container or as one executable) starts at 0.1.0: end-to-end encrypted transfers directly between browsers over WebRTC when possible and through the relay otherwise, resume after a dropped connection, previews and renaming, operator limits with a daily relay budget, and opt-in counters. The seam libraries start at 1.0.0: `@file-transfer/parcel` implements the frozen parcel format v1 (docs/parcel.md), and `@file-transfer/transport` the room protocol (docs/protocol.md), whose versions follow docs/versioning.md strictly from here on.
