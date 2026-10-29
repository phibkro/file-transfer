---
"@file-transfer/web": patch
---

The recipient follows an explicit life cycle. When saving the received files fails, it now tells the sender and frees the storage instead of hanging at 100%; Accept and Decline disappear when a transfer fails while the offer is on screen; and an abort that arrives while storage is opening is no longer overwritten.
