# Spike 0002: transfers end to end, by size, distance and browser

Status: in progress (2026-10-28). Code: `apps/web/scripts/endToEnd.ts` (suites `standard`, `latency`, `large`) and `apps/web/scripts/latencyProxy.ts`. Answers part of M0 in `plan.md`: whether 10 GB transfers work, how round-trip time limits throughput, and which browsers can receive.

Unless stated otherwise, both browsers and the server ran on one 2-core cloud container: `wrangler dev` (Worker and Durable Object on workerd) serving the built `apps/web`, two Chromium profiles from Playwright 1.63. Every byte crosses the same machine several times, so speeds here are a floor set by this machine's CPU, not network figures.

## Results

| Question                               | Result                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Does a 10 GB transfer complete?        | Yes: 10.0 GB in 981 s (10.2 MB/s) through the local Worker and Durable Object. The received file had the sent size, and 11 random markers (one per GiB and one at the end) and the zeros after them were at their offsets. The parcel's labels checked every record's contents on the way.                                                       |
| Does round-trip time limit throughput? | With the recipient's old credit window of 64 records (4 MiB), yes: 128 MB at 0 / 50 / 150 / 300 ms round trips ran at 10.5 / 8.9 / 7.3 / 5.2 MB/s. With 256 records (16 MiB) it ran at 10.8 / 10.1 / 9.5 / 9.7 MB/s, so the window, not the relay, was the limit. The app now uses 256.                                                          |
| What does a private window allow?      | A fresh Playwright context counts as a private window, and Chromium gave it a storage quota of 2.147 GB (`navigator.storage.estimate()`). The first 10 GB attempt failed partway when the recipient's files filled it. The recipient now compares the estimate with the contract's total before Accept and explains when the files will not fit. |
| Which browsers receive correctly?      | Chromium and Firefox pass the standard suite in CI (GitHub's runners, Playwright 1.63). WebKit on Linux completes the transfer, with every record matching its label in memory, but three of four files read back with the wrong SHA-256 (the empty file matches). Under investigation; see below.                                               |
| Production, over the internet          | Before these changes: 268 MB in 44 to 45 s (6.0 to 6.1 MB/s) with both browsers in one container, all checks passing (spike 0001 follow-up).                                                                                                                                                                                                     |

## Method notes

- **Latency** comes from `latencyProxy.ts`, a TCP proxy between the browsers and `wrangler dev` that holds every chunk for half the round trip in each direction and keeps order; bandwidth is not limited, so it isolates the effect of distance.
- **Large files** are sparse, so the sender's copy costs no disk; only the recipient's 10 GB is written. A browser cannot hash 10 GB in memory, so the check samples offsets through `fileSlice` and compares the size.
- **WebKit** needs a persistent profile for the origin-private file system (its ephemeral contexts count as private browsing; microsoft/playwright issue 18235), which the suite provides.

## Open

- **WebKit writes.** The recipient decrypts and verifies each record, then writes it with `FileSystemWritableFileStream.write({ type: "write", position, data })` and closes the stream. Candidate causes: `close()` resolving before the file is committed (an open WebKit change, WebKit pull request 78451, bug 329088), or the write taking the whole underlying buffer of a `Uint8Array` view. The end-to-end check now reports the first differing offset when hashes differ. Whatever the cause, the sink should verify what is on disk before saying "complete": keep each record's SHA-256 (32 bytes per 64 KiB record, 5 MB for 10 GB), read the files back after closing, and compare.
- **Safari and iPhone.** Safari 26 added `createWritable` (Safari 26 release notes). Getting a multi-gigabyte file out to Files on iOS is unverified; WebKit bug 256698 and StreamSaver.js issue 373 report failures around 1 to 2 GB. Needs a real device.
- **Relay memory.** A 16 MiB window lets that much wait in a room's socket buffers when a recipient falls behind; the relay load test must confirm this is safe for Durable Object memory.
- **Real networks.** The matrix in `plan.md` (home broadband, mobile data, other cities, locked-down Wi-Fi), filled from the completion reports.
