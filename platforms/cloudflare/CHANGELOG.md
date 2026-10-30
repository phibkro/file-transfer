# @file-transfer/platform-cloudflare

## 0.5.5

### Patch Changes

- @file-transfer/service-quota@0.5.5
  - @file-transfer/service-telemetry@0.5.5

## 0.5.4

### Patch Changes

- @file-transfer/service-quota@0.5.4
  - @file-transfer/service-telemetry@0.5.4

## 0.5.3

### Patch Changes

- 4bd2eb0: Drops the unused `workerd` devDependency; wrangler brings its own. The Worker it builds is unchanged.

  Repository: knip checks dependency hygiene in `bun run check`, replacing the module graph check's unused-dependency rule.

- @file-transfer/service-quota@0.5.3
  - @file-transfer/service-telemetry@0.5.3

## 0.5.2

### Patch Changes

- @file-transfer/service-quota@0.5.2
  - @file-transfer/service-telemetry@0.5.2

## 0.5.1

### Patch Changes

- @file-transfer/service-quota@0.5.1
  - @file-transfer/service-telemetry@0.5.1

## 0.5.0

### Minor Changes

- 849482b: A room now remembers that a recipient completed and tells a sender that joins afterwards. A sender whose connection dropped just as the transfer finished, and that came back after the recipient had left, used to wait for the recipient forever; it now shows the transfer as delivered.

### Patch Changes

- @file-transfer/service-quota@0.5.0
  - @file-transfer/service-telemetry@0.5.0

## 0.4.5

### Patch Changes

- @file-transfer/service-quota@0.4.5
  - @file-transfer/service-telemetry@0.4.5

## 0.4.4

### Patch Changes

- @file-transfer/service-quota@0.4.4
  - @file-transfer/service-telemetry@0.4.4

## 0.4.3

### Patch Changes

- @file-transfer/service-quota@0.4.3
  - @file-transfer/service-telemetry@0.4.3

## 0.4.2

### Patch Changes

- @file-transfer/service-quota@0.4.2
  - @file-transfer/service-telemetry@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [410c3e4]
  - @file-transfer/transport@1.2.0
  - @file-transfer/service-quota@0.4.1
  - @file-transfer/service-telemetry@0.4.1

## 0.4.0

### Patch Changes

- @file-transfer/service-quota@0.4.0
  - @file-transfer/service-telemetry@0.4.0

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
