# @file-transfer/service-room

## 0.5.4

No changes in this release.

## 0.5.3

No changes in this release.

## 0.5.2

No changes in this release.

## 0.5.1

No changes in this release.

## 0.5.0

No changes in this release.

## 0.4.5

No changes in this release.

## 0.4.4

No changes in this release.

## 0.4.3

No changes in this release.

## 0.4.2

No changes in this release.

## 0.4.1

No changes in this release.

## 0.4.0

### Minor Changes

- 6fb7536: Machines now expose their full state × command matrix, illegal pairs included (`Machine.matrix`, `Machine.toTable`), and `Machine.problems` reports a command whose transitions from one state cannot be told apart. `transitionTableCheck` checks a service against every cell of its machine's table, and the room and relay services declare it as their `follows-machine` guarantee. The relay meter now reports the session's state. `docs/state-machines.md` is generated from the tables.

### Patch Changes

- Updated dependencies [6fb7536]
  - @file-transfer/machine@0.2.0
  - @file-transfer/conformance@0.2.0

## 0.3.0

No changes in this release.

## 0.2.0

No changes in this release.

## 0.1.1

### Patch Changes

- Updated dependencies [7ef4f07]
  - @file-transfer/parcel@1.0.1

## 0.1.0

### Patch Changes

- Updated dependencies [6b50b85]
  - @file-transfer/parcel@1.0.0
  - @file-transfer/machine@0.1.0
  - @file-transfer/conformance@0.1.0
