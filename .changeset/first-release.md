---
"@file-transfer/parcel": major
"@file-transfer/transport": major
"@file-transfer/web": minor
"@file-transfer/client": minor
"@file-transfer/sink": minor
"@file-transfer/machine": minor
"@file-transfer/conformance": minor
---

First versioned release. The product (web client, server node on Cloudflare, in a container or as one executable) starts at 0.1.0: end-to-end encrypted transfers directly between browsers over WebRTC when possible and through the relay otherwise, resume after a dropped connection, previews and renaming, operator limits with a daily relay budget, and opt-in counters. The seam libraries start at 1.0.0: `@file-transfer/parcel` implements the frozen parcel format v1 (docs/parcel.md), and `@file-transfer/transport` the room protocol (docs/protocol.md), whose versions follow docs/versioning.md strictly from here on.
