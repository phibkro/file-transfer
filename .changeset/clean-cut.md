---
"@file-transfer/web": patch
---

A recipient that has received every file now stays connected for its whole linger when the sender leaves, so a sender whose connection dropped before it heard "complete" rejoins and finishes instead of waiting forever. The end-to-end suite's clean socket cut now really closes the server's end, which is how this was found.
