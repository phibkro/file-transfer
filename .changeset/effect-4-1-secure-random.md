---
"@file-transfer/service-abuse": minor
"@file-transfer/service-relay": minor
"@file-transfer/service-room": minor
---

Runs on Effect 4.1.0. The reference layers now require Effect's `SecureRandom` (from `effect/crypto`) instead of `Crypto`, which Effect 4.1.0 removed: provide `SecureRandom.layerWebCrypto`, or your runtime's `SecureRandom`, where you provided `Crypto`. Identifiers are still 16 secure random bytes in hex, and every guarantee and negative control is unchanged.
