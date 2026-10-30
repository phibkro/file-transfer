---
"@file-transfer/web": patch
---

When a transfer stops right after its files were opened for writing, the recipient now retries removing the half-written folder for a moment instead of leaving it until the next visit (Chromium briefly refuses the removal). The browser suite also patches storage on prototypes, which WebKit keeps, so its storage checks no longer fail at random there.
