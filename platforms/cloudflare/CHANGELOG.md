# @file-transfer/platform-cloudflare

## 0.3.0

### Patch Changes

- @file-transfer/service-quota@0.3.0
  - @file-transfer/service-telemetry@0.3.0

## 0.2.0

### Minor Changes

- cc21d36: A socket that goes silent without closing (a NAT forgetting the connection, a phone changing networks) no longer stalls a transfer: rooms now answer liveness pings and say so in `joined` (`answersPings`), and endpoints ping after 10 seconds of silence and rejoin after 20, resuming from what is missing. Before, such a transfer could hang until the browser's TCP timeout, many minutes later. Older rooms and endpoints keep working as before (docs/protocol.md, "Liveness").

### Patch Changes

- Updated dependencies [cc21d36]
  - @file-transfer/transport@1.1.0
  - @file-transfer/service-quota@0.2.0
  - @file-transfer/service-telemetry@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [7ef4f07]
  - @file-transfer/parcel@1.0.1
  - @file-transfer/service-quota@0.1.1
  - @file-transfer/service-telemetry@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [6b50b85]
  - @file-transfer/parcel@1.0.0
  - @file-transfer/transport@1.0.0
  - @file-transfer/service-quota@0.1.0
  - @file-transfer/service-telemetry@0.1.0
