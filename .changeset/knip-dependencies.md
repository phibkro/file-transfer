---
"@file-transfer/platform-cloudflare": patch
---

Drops the unused `workerd` devDependency; wrangler brings its own. The Worker it builds is unchanged.

Repository: knip checks dependency hygiene in `bun run check`, replacing the module graph check's unused-dependency rule.
