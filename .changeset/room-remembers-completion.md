---
"@file-transfer/platform-cloudflare": minor
---

A room now remembers that a recipient completed and tells a sender that joins afterwards. A sender whose connection dropped just as the transfer finished, and that came back after the recipient had left, used to wait for the recipient forever; it now shows the transfer as delivered.
