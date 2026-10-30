---
"@file-transfer/platform-cloudflare": patch
"@file-transfer/service-quota": patch
"@file-transfer/service-telemetry": patch
"@file-transfer/sink": patch
"@file-transfer/transport": patch
---

Runs on Effect 4.1.0, with no change in behaviour. Deploys keep working: Alchemy 2.0.0-beta.84 is patched to Effect 4.1's crypto modules (`patches/README.md`), and every `@effect` package is pinned to the effect version.
