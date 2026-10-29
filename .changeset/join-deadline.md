---
"@file-transfer/web": patch
---

A socket whose join the room never answers (opened, then lost on a silent network) is given up after 15 seconds and replaced, instead of waiting minutes for the browser to notice.
