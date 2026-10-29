---
"@file-transfer/web": patch
---

The browser leak checks now read Blob, File and FormData request bodies in every browser; in the app, only a comment in the address module changes. Nothing changes for people using the app.
