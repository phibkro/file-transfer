---
"@file-transfer/web": patch
"@file-transfer/transport": minor
---

A socket whose join the room never answers (opened, then lost on a silent network) is given up after 15 seconds and replaced, instead of waiting minutes for the browser to notice. The room protocol gains one endpoint close code for it, 4100 ("no answer to join"); codes an endpoint adds from now on start at 4100, clear of the room's own. Existing codes keep their meanings, and the room ignores endpoint close codes.
