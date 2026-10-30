---
"@file-transfer/conformance": patch
---

The `fileTransfer.testSupportFiles` key leaves package.json; the module graph configuration (`ox-dep-lint.config.ts`) now names the suite's entry as test support. The package's code is unchanged.

Repository: the module graph check is now ox-dep-lint, in `bun run check:graph` and as an oxlint plugin in `vp check`.
