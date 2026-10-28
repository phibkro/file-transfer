# Plan

Startup phase: prove that people want this and that some will pay, before stabilising or optimising. Phases 0 and 1 are roughly eight weeks of focused solo work (an estimate; the spike is the main uncertainty).

## Phases and gates

| Phase              | Scope                                                                                             | Gate to the next phase                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 0 Spike and format | Measure throughput and save tiers; write format v1 with test vectors; external review             | 5 GB transfers work on every target browser; format reviewed and frozen                       |
| 1 MVP launch       | Live encrypted transfers, relay fallback, resume, abuse page, fake doors; Show HN; no money taken | Completion and repeat-sender targets met; fake-door clicks above the threshold set in advance |
| 2 Paid store       | Accounts, R2 store with expiry and revoke, merchant-of-record billing                             | Paying users; relay plus TURN cost above the fixed cost of own relays                         |
| 3 Stabilise        | Own relays (workerd or celld, Bun fallback), coturn, self-host parity                             | Teams or self-hosters asking for private networks and native clients                          |
| 4 The network      | Rust iroh nodes and CLI, network directory and policies, seeding, PAKE codes                      |                                                                                               |

## M0 Spike (week 1)

- [x] Scaffold the monorepo (this commit)
- [ ] Throughput harness: 5 GB synthetic stream, direct WebRTC versus Durable Object relay, MB/s against RTT
- [ ] Save-tier test (picker, service worker, OPFS) on Chrome, Firefox, Safari desktop, Android Chrome, iOS Safari
- [ ] Durable Object load test: sustained MB/s per object, slow-receiver behaviour, cost per GB from billing
- [ ] Run the same Worker and Durable Object code (hibernation included) on workerd; confirm Effect services run inside a Durable Object
- [ ] Record results in `docs/spikes/` and decide record size, frame size, and direct-first versus relay-first for large files

## M1 Format (week 2)

- [ ] Implement `libraries/format` per `format.md` (lift SkySend's crypto where it fits; credit it)
- [ ] Test vectors and property-based tests
- [ ] Two-page spec review by someone with applied-crypto experience; freeze v1

## M2 Transfer (weeks 3 and 4)

- [x] Guarantees with negative controls in every service suite (ADR 0007), life cycles as machines (ADR 0008), module graph, Effect lint and secret scanning in `bun run check` and CI (ADR 0009)
- [ ] `services/room` and `services/relay`: reference layers and conformance suites, then Cloudflare layers, credit-based flow control
- [ ] `libraries/transport`: direct and relayed paths, relay-first switching, resume
- [ ] `libraries/sink`: save tiers and OPFS resume bitmap
- [ ] Network matrix: home broadband, mobile data, corporate Wi-Fi, two browsers per side

## M3 Launch readiness (week 5)

- [ ] Landing page answering: Firefox Send's abuse problem, when TURN or the relay sees traffic, how to trust the served JavaScript
- [ ] Turnstile on room creation, per-IP limits in `services/quota`, `/abuse` form, privacy policy, terms
- [ ] Aggregate counters in `services/telemetry`, Umami on the landing page
- [ ] Fake doors after a completed transfer (offline recipients, faster relayed transfers, private network), waitlist, Van Westendorp survey
- [ ] `platforms/self-hosted` on workerd (Bun layers only if M0 rules workerd out), Docker image, Nix module

## M4 Launch and learn (weeks 6 to 8)

- [ ] Show HN; fix the top failure reason each week
- [ ] Weekly metrics review; decide on phase 2 at the end of week 8

## Metrics (thresholds are starting hypotheses; fix them before launch)

| Metric                 | Definition                                                                      | Threshold                           |
| ---------------------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| Completion rate        | Full file received, over transfers where a recipient joined                     | at least 97%                        |
| Activation             | Links created that lead to a completed transfer                                 | at least 40%                        |
| Repeat senders         | Week-1 senders who send again in weeks 2 to 4 (device-level estimate)           | at least 20%                        |
| Paid-feature demand    | Completed-transfer users who click a paid fake door; share joining the waitlist | at least 5% click; at least 1% join |
| Relayed share and cost | Relayed bytes over total; relay plus TURN cost per month                        | tracked; feeds gate 3               |

## Open decisions

- Positioning: consumer, or teams from the start (test a team offer as a fake door in phase 1)
- Who reviews the format spec in M1
- Brand name, domain, trademark, and who holds them
- Vite with plain TypeScript or Astro for the landing page
- Apply for Stripe Managed Payments early (eligibility review takes time)
