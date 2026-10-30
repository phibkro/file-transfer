---
"@file-transfer/platform-cloudflare": patch
---

Deploys with Alchemy 2.0.0-beta.84 and its separate `@alchemy.run/cloudflare` provider package, with the Worker Preview asset settings fix carried over. CI deploys and destroys now stop, naming both versions, unless the account's shared Alchemy state store answers at the version the installed Alchemy expects, instead of letting `--yes` replace or downgrade the store (ADR 0025).
