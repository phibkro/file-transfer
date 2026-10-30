---
"@file-transfer/conformance": minor
---

Runs on Effect 4.1.0. `secureCrypto` is renamed `secureRandom` and provides Effect's `SecureRandom` (`SecureRandom.layerWebCrypto`) instead of `Crypto`, which Effect 4.1.0 removed; it no longer offers a digest, which no reference layer used.
