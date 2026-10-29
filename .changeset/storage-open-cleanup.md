---
"@file-transfer/web": patch
---

When the browser cannot open storage for a transfer (a full disk, say), the recipient now gives back the storage lock and removes the files it had started, so they no longer linger until the tab closes.
