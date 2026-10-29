---
"@file-transfer/web": patch
---

The web app reads its own address in one module, and a lint rule stops any other code from reading the URL fragment that holds the link secret. Nothing changes for people using the app.
