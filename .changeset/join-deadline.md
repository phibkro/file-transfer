---
"@file-transfer/web": patch
---

A socket whose join the room never answers (opened, then lost on a silent network) is given up after 15 seconds and replaced, instead of waiting minutes for the browser to notice. Endpoint close codes move to their own range so none shares a number with the room's: a silent socket now closes with 4100 (was 4001) and an unanswered join with 4101. The room ignores endpoint close codes.
