---
"@file-transfer/parcel": patch
---

`isWindowsDeviceName` strips trailing spaces with a linear scan instead of the regular expression `/ +$/`, which took quadratic time on a long run of spaces (CodeQL js/polynomial-redos). Results are unchanged, and so is the wire format: within a parcel, segments are at most 255 bytes, so only callers passing longer strings were affected.
