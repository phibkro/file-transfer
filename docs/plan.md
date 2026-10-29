# Plan

Startup phase: prove that people want this, then that some will pay, before stabilising or optimising. Since ADR 0019 the first launch is open source: operators run instances (their own Cloudflare account or self-hosted), and the hosted paid product waits for the adoption gate. Phases 0 and 1 are roughly eight weeks of focused solo work (an estimate; the spike is the main uncertainty).

## Phases and gates

| Phase                | Scope                                                                                                                                                                                            | Gate to the next phase                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 0 Spike and parcel   | Measure throughput and save tiers; write parcel v1 with test vectors; external review                                                                                                            | 10 GB transfers work on every target browser; parcel v1 reviewed and frozen                                |
| 1 Open-source launch | Live encrypted transfers, resume; operator limits, counters and `/admin`; Deploy to Cloudflare, Alchemy and workerd self-hosting; demo instance; Show HN and self-hosting communities (ADR 0019) | Adoption: stars, outside issues and pull requests, demo completion rate, against thresholds set in advance |
| 2 Hosted product     | Accounts, R2 store with expiry and revoke, relay priority, merchant-of-record billing (ADR 0006, 0014); fake doors first                                                                         | Paying users; relay plus TURN cost above the fixed cost of own relays                                      |
| 3 Stabilise          | Own relays (workerd or celld, Bun fallback), coturn, self-host parity                                                                                                                            | Teams or self-hosters asking for private networks and native clients                                       |
| 4 The network        | Rust iroh nodes and CLI, network directory and policies, seeding, PAKE codes                                                                                                                     |                                                                                                            |

## M0 Spike (week 1)

- [x] Scaffold the monorepo (this commit)
- [ ] Throughput harness: 10 GB synthetic stream, direct WebRTC versus Durable Object relay, MB/s against RTT
  - Relay half done (spike 0002): 10 GB completes through the local Worker and Durable Object; with a 16 MiB credit window throughput holds from 0 to 300 ms round trips. Direct WebRTC not started
- [ ] Save-tier test (picker, service worker, OPFS) on Chrome, Firefox, Safari desktop, Android Chrome, iOS Safari
  - OPFS output passes in Chromium, Firefox and WebKit on Linux (CI); Save all uses the folder picker where it exists. Real Safari, Android and iPhone (large files out of OPFS) not yet tested
- [x] Durable Object load test: sustained MB/s per object, slow-receiver behaviour, cost per GB (`docs/spikes/0003-relay-load.md`: 28 to 78 MB/s per room, stalled recipients safe, about $0.19 to $0.70 per TiB at list prices, 120 GiB a day on the free plan; Cloudflare's edge negotiates WebSocket compression regardless of the flag)
- [ ] Lossy-link test (phone hotspot): reliable ordered data channel versus unordered with zero retransmits plus want lists (ADR 0013)
- [ ] Choose the relay cap (10, 25 or 50 GB) from the load test: completion rate with resume, duration per object, cost per transfer, and the share of transfers that would hit each cap
  - 25 GB by default (2026-10-29, after spike 0003); the share hitting each cap waits for opt-in counters. An instance-wide daily relay budget (`LIMIT_RELAYED_BYTES_PER_DAY`, 100 GB on Cloudflare) protects a free-plan quota
- [x] Run the same Worker and Durable Object code (hibernation included) on workerd; confirm Effect services run inside a Durable Object (`docs/spikes/0001-workerd-durable-object.md`: yes on both; loopback relay 235 to 456 MB/s; compression must be off)
- [ ] Record results in `docs/spikes/` and decide record size, frame size, and direct-first versus relay-first for large files

## M1 Parcel (week 2)

- [x] Implement `libraries/parcel` per `parcel.md` (written fresh rather than lifted: SkySend's ECE layout differs in nonce, commitment and Merkle tree)
- [x] First review (agent reviewer) and revision: synthetic nonces, canonical manifest, name profile, contract with labels and label pages (ADR 0011, ADR 0012)
- [x] Test vectors (checked by an independent Python implementation in CI) and property-based tests
- [x] Second review (agent reviewer, second pass) and freeze: receivers pin the contract digest, names reject code points unassigned in Unicode 15.1, a normalizer sentinel; parcel v1 frozen 2026-10-28 (ADR 0011)
- [ ] Human applied-crypto review before launch (recommended); a flaw it finds is fixed in version 2

## M2 Transfer (weeks 3 and 4)

- [x] Guarantees with negative controls in every service suite (ADR 0007), life cycles as machines (ADR 0008), module graph, Effect lint and secret scanning in `bun run check` and CI (ADR 0009)
- [ ] `services/room` and `services/relay`: reference layers and conformance suites, then Cloudflare layers, credit-based flow control
  - From spike 0001: relay session state as a value with pure transitions (a `Ref` in the reference layer, socket attachments or `ctx.storage` in the Durable Object, so a pause past hibernation keeps credits); the object is the session (`idFromName`), forwards frames without queueing, sets `binaryType = "arraybuffer"` and `no_web_socket_compression`
  - `libraries/transport`: allow several records per frame (256 KiB to 1 MiB) to cut CPU and billed messages
- [ ] `libraries/transport`: direct and relayed paths, relay-first switching, resume
- [ ] `libraries/sink`: save tiers and OPFS resume bitmap; provisional output until the parcel verifies; rename on write when a file system refuses a name the parcel allowed (ADR 0011)
  - Second review S4: NTFS's upcase table maps both `ı` (U+0131) and `i` to `I`, so names the parcel's full case folding keeps apart can collide on Windows; Windows opens the console for `CONIN$` and `CONOUT$`, which the parcel's device list does not cover. The sink checks collisions with the target's own folding and renames on write
- [x] `apps/web` send and receive over a room (docs/protocol.md): labelling with progress, share link, contract offer and accept, credits, want ranges, resume after either side drops, provisional OPFS output, downloads, and a test hook (`window.fileTransferTest`). Verified end to end against `platforms/cloudflare` under `wrangler dev` and in production (`apps/web/scripts/endToEnd.ts`: byte-identical files, resume after clean and half-open cuts, decline, wrong keys, no secret or file name in any request or frame)
  - For the MVP the transfer orchestration lives in `apps/web/src` as plain TypeScript (with reasoned file-level Effect lint exceptions). Once the MVP proves out it moves into `libraries/client` as Effect services: the sender and recipient life cycles as `libraries/machine` tables, the room socket as a transport path, and `storage.ts` as the OPFS tier of `libraries/sink`
  - Platforms serve `apps/web/dist` with `/r/*` answered by `index.html`
- [x] Deploys with Alchemy from `wrangler.jsonc`: production at send.phibkro.org, Worker Previews per pull request, both verified end to end by CI once `DEPLOYMENTS` is enabled (`platforms/cloudflare/README.md`)
- [x] Share panel (Copy, Share sheet, link and QR code hidden until asked for), files added in batches, completion report for network testing
- [x] Recipient safeguards: storage check before Accept, mobile-data confirmation, Save all, asking before leaving with something to lose
- [x] Storage hygiene: received files do not outlive their page (Web Locks and a sweep on load); "Storage in this browser" shows and clears them
- [x] Renaming (senders until sealing, recipients for what they save) and previews in a sandboxed, opaque-origin frame (ADR 0018)
- [ ] Network matrix: home broadband, mobile data, corporate Wi-Fi, two browsers per side (paste the completion reports)
  - Three sender reports so far (home, Tailscale, cellular; Firefox; a few MB each, spike 0002). Needs recipient reports and transfers of 100 MB or more

## M3 Operators and distribution (ADR 0019)

- [x] Operator limits enforced by the room server: rooms per client address per hour, relayed bytes per room; `GET /api/limits` read by the app before sealing (Turnstile still to come, opt-in)
- [x] Counters in a SQLite-backed Durable Object (hourly buckets, no identifiers), opt-in with `COUNTERS=on`; JSON and OpenMetrics at `/api/admin/*` behind `ADMIN_TOKEN` (self-hosted layer still to come)
- [x] `/admin` behind `ADMIN_TOKEN` (and optionally Cloudflare Access): settings, completion share, relayed volume, a 48-hour chart (uPlot, loaded on that page only), totals
- [x] Deploy to Cloudflare: CI publishes a prebuilt, self-contained bundle to the `deploy` branch for the button (a real click-through on a fresh account is still to be tried)
- [x] `platforms/self-hosted` on workerd, Docker image at ghcr.io/phibkro/file-transfer, tested end to end in CI (Nix module after)
- [x] README as the landing page: deploy in one click or one command, what operators see, why relays see only ciphertext

## M3b Launch readiness (week 5)

- [ ] Landing page answering: Firefox Send's abuse problem, when TURN or the relay sees traffic, how to trust the served JavaScript
- [ ] `/abuse` form, privacy policy and terms for the demo instance (limits and Turnstile moved to M3)
  - Production has none of these yet: `services/quota`, `services/abuse` and `services/telemetry` exist as reference layers but no platform wires them in, so room creation and relaying are unlimited
- [ ] (moved to M3: counters for every instance; nothing phones home)
- [ ] Fake doors and pricing survey: deferred to phase 2 (ADR 0019)
- [ ] (moved to M3: self-hosting on workerd)

## M4 Launch and learn (weeks 6 to 8)

- [ ] Show HN; fix the top failure reason each week
- [ ] Weekly metrics review; decide on phase 2 at the end of week 8

## Metrics (thresholds are starting hypotheses; fix them before launch)

| Metric                 | Definition                                                                                 | Threshold                           |
| ---------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------- |
| Completion rate        | Full file received, over transfers where a recipient joined (demo instance counters)       | at least 97%                        |
| Activation             | Rooms created that lead to a completed transfer (demo instance counters)                   | at least 40%                        |
| Adoption               | GitHub stars; outside issues and pull requests; operators who tell us they run an instance | set before launch (ADR 0019)        |
| Paid-feature demand    | Phase 2: completed-transfer users who click a paid fake door; share joining the waitlist   | at least 5% click; at least 1% join |
| Relayed share and cost | Relayed bytes over total; relay plus TURN cost per month                                   | tracked; feeds gate 3               |

Repeat senders cannot be counted without identifying devices, which counters exclude (ADR 0019); they wait for accounts.

## Open decisions

- Positioning: consumer, or teams from the start (test a team offer as a fake door in phase 2)
- Adoption thresholds for the phase 1 gate (ADR 0019)
- Default limits for new instances: 50 rooms per address per hour, 25 GB per room and 100 GB a day per Cloudflare instance (2026-10-29); revisit with real usage
- Who gives parcel v1 its human applied-crypto review before launch
- Brand name, domain, trademark, and who holds them
- Vite with plain TypeScript or Astro for the landing page
- Apply for Stripe Managed Payments early (eligibility review takes time)
