# Research record

Long-form research, with sources for every claim, lives in two Claude docs:

- Market and architecture study: https://claude.ai/artifact/KX94noffB55dUiq3prkGBy
- Build design and plan (codebases, libraries, business stack, platforms, ecosystems): https://claude.ai/artifact/3DkmofyPqFrWk1iuX8ZcoH

This file keeps the numbers and findings that drove decisions, as read on 2026-10-28.

## Market

- No tool combines browser-first, end-to-end encryption, streaming, automatic NAT traversal, and open self-hosting with a paid hosted tier. Nearest: Wormhole.app (closed, 5 GB stored path, 24 h expiry). Moving closer: croc (relay plus opt-in store), DashBeam (iroh relays, browser always relayed).
- transfer.zip, with the same free-P2P and paid-storage model, shows $907 MRR and $23,589 all-time revenue since April 2024 (TrustMRR). Expect a hard consumer business case.
- Firefox Send died in 2020 from malware abuse with nobody to handle it, plus portfolio cost.

## Codebases to lift from (all compatible with AGPL-3.0)

| Source                              | Licence      | Take                                                                                                                                                                 |
| ----------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SkySend (github.com/Skyfay/SkySend) | AGPL-3.0     | `packages/crypto` (ECE, AES-256-GCM 64 KiB records, key in fragment), download tiers (service worker, File System Access, OPFS for Safari), Hono + SQLite + S3 store |
| transfer.zip-web                    | AGPL-3.0     | Live pipeline reference, relay over signaling WebSocket with packet budget, Stripe routes                                                                            |
| croc                                | MIT          | `STORED_TRANSFERS.md` as the store spec, `stored-crypto.ts`                                                                                                          |
| FilePizza                           | BSD-3-Clause | Ephemeral coturn credentials (`api/ice`, `coturn.ts`)                                                                                                                |
| Send (timvisee)                     | MPL-2.0      | `ece.js` reference                                                                                                                                                   |
| wormhole-crypto                     | MIT          | `decryptStreamRange` idea for ranged resume                                                                                                                          |

### Lifted so far

| Origin                                                                                                                                                                                 | Licence     | Into                                                                                                                                                    | What                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phibkro/vektorprogrammet-reimagined, machine module (its ADR 0007)                                                                                                                     | same author | `libraries/machine`                                                                                                                                     | Transition tables, `problems`, Mermaid output; simplified                                                                                                                                                                                                                                                           |
| phibkro/vektorprogrammet-reimagined, store-capability contract suites (its ADR 0014)                                                                                                   | same author | `libraries/conformance`                                                                                                                                 | Named guarantees, broken variants as negative controls                                                                                                                                                                                                                                                              |
| phibkro/vektorprogrammet-reimagined, module-layer check (its ADR 0015)                                                                                                                 | same author | `tools/quality`                                                                                                                                         | Module graph rules as data, with a check                                                                                                                                                                                                                                                                            |
| job-index `infra/alchemy.run.ts`, occupational-health `deploy/alchemy.run.ts`                                                                                                          | same author | `spikes/0001-workerd-durable-object/alchemy.run.ts`                                                                                                     | Async-style Alchemy v2 Worker with Durable Object binding, stage guard, secret from `Config.Redacted`                                                                                                                                                                                                               |
| `spikes/0001-workerd-durable-object` (this repository)                                                                                                                                 | AGPL-3.0    | `platforms/cloudflare` (`roomObject.ts`, `wrangler.jsonc`, build script)                                                                                | Hibernating Durable Object with socket attachments, ArrayBuffer frames, close handshake in `webSocketClose`, `no_web_socket_compression`, esbuild bundle served by wrangler dev with `no_bundle`                                                                                                                    |
| cn-homage, `packages/core/src/7-bulk/names.ts` and its test                                                                                                                            | same author | `libraries/parcel` (`names.ts`)                                                                                                                         | Portable name rules; adapted to reject instead of rename, Cf added, case folding from Unicode 15.1 tables; device names cross-checked against disktree's `misread_by_win32`                                                                                                                                         |
| pstack by Lauren Tan (cursor/plugins, `pstack/skills`, 0.15.36): `create-verification-skill`, `maintain-verification-skill`, `opening-a-pr`, `shipping`, `interrogate`, `blast-radius` | MIT         | `.claude/skills/` (`verify-file-transfer` generated by following it; `maintain-verification-skill`, `open-pull-request`, `review-pull-request` adapted) | Verification skill with a feature map and evidence rules, its upkeep loop, the pull request body, independent PASS/PASS+NOTES/FAIL verdicts, findings proven by runs, the one safety fact; licence in `.claude/skills/PSTACK-LICENSE.txt`                                                                           |
| phibkro/vektorprogrammet-reimagined, `.agents/skills/review-pr` (`cfa8c74`, `797e9e4`)                                                                                                 | same author | `.claude/skills/review-pull-request`                                                                                                                    | Severity scale (critical, high, medium, low, nit) rewritten for this repository's invariants, the pass rule (nothing open at medium or above), the review loop with a separate fixer, fresh reviewers per round and a three-round limit, and the review marker naming the head commit; merging stays with the owner |

## Platform numbers

- Durable Objects: outgoing WebSocket messages free, incoming billed 20:1 ($0.15 per million requests), duration $12.50 per million GB-s on a fixed 128 MB; 32 MiB max received message; 1,000 requests/s soft limit per object. Relay estimate $0.3 to $2 per TB (arithmetic, not load-tested).
- Cloudflare TURN: 1,000 GB/month free, then $0.05/GB egress; packet loss above 50 to 100 Mbps per client.
- R2: $0.015/GB-month, free egress, multipart parts 5 MiB to 5 GiB; lifecycle deletion only "typically within 24 hours".
- Hetzner: 20 TB included per EU server, about EUR 1/TB beyond.
- Cloudflare terms: the CDN restricts large files and names the Developer Platform as the route for them; Developer Platform terms have no relay or bandwidth rule beyond a "burden on the network" clause.
- workerd: Apache-2.0, Durable Objects on a single node only, "not a hardened sandbox". celld (Deno): Workers and Durable Objects across machines, v0.1.0 (2026-08-05).

## Browser facts

- WebRTC data channels are the only direct browser path; default max message 64 KiB.
- WebCrypto AES-GCM 5.67 GiB/s versus pure-JS AES-GCM 94.8 MiB/s (noble-ciphers benchmark, Apple M4). WebCrypto has no streaming AEAD and no BLAKE3.
- `showSaveFilePicker` is Chromium desktop only; OPFS `createWritable` reached Safari in 26.

## Ecosystems

- TypeScript (Bun, Effect) for browser, edge and self-hosted platform; Effect 4.0 stable (4.0.7, LTS to 2029-09); `effect/cluster` stability unstated.
- Rust for native nodes (iroh 1.4.1) and CLI in phase 4, as a second implementation of parcels checked by shared vectors.
- BEAM is strong for rooms and relays but would duplicate every service; it cannot run on Workers. JVM offers no decisive advantage.

## Prior art for the protocol (2026-10-29)

Checked against 17 systems (magic-wormhole, croc, Firefox Send, RFC 8188, Thunderbird Send, Wormhole.app, FilePizza, PairDrop, Tahoe-LAFS, BitTorrent v2, Hypercore, IPFS, iroh, Syncthing, age, STREAM, SIV). No system had more than about four of our eight properties.

- Established, cite rather than claim: the key in the URL fragment (Firefox Send, Wormhole.app), streaming record encryption (RFC 8188, age STREAM), a direct path with relay fallback (magic-wormhole Dilation, croc, iroh; PairDrop is the same idea as our direct path), recipient-driven fetching of missing pieces (BitTorrent, Bitswap, iroh-blobs), deterministic authenticated encryption (SIV, RFC 8452).
- Not found elsewhere: relays and stores that check ciphertext against public labels and Merkle pages without a key, inside a link-key end-to-end scheme. In parcel v1 the root is sealed in the manifest, so a keyless carrier checks that records and pages are consistent with one root, not that the root is the contract's (ADR 0024). Tahoe-LAFS and BitTorrent check without a key but have no link-key encryption; Wormhole.app encrypts its torrent metadata, so its server cannot check pieces; Syncthing's untrusted devices cannot verify at all.
- A combination, not a primitive: deterministic per-record sealing that drives resume and repair. It reveals record equality only for the same record position in the same parcel, since the nonce binds the counter and the per-parcel salt (`parcel.md`).
- Sources: magic-wormhole.readthedocs.io (transit, dilation-protocol), github.com/mozilla/send (docs/encryption.md), rfc-editor.org/rfc/rfc8188, wormhole.app/security, tahoe-lafs.readthedocs.io (architecture, file-encoding), bittorrent.org/beps/bep_0052.html, docs.rs/iroh-blobs, docs.syncthing.net/specs/untrusted.html, C2SP age.md, eprint.iacr.org/2015/189, rfc-editor.org/rfc/rfc8452.

## Incentives for intermediaries (2026-10-29)

Input to ADR 0024.

- Storj: client-side encryption, paid operators, pays in USDC and "no longer pays out in STORJ tokens" (storj.dev/node/payouts); vets nodes and withholds early earnings against Sybil operators (static.storj.io/storjv3.pdf).
- Filecoin: utilisation 7.6% of 12.2 EiB in Q2 2023 (Cointelegraph), 36% of 3.0 EiB in Q3 2025 (Messari, via KuCoin); retrieval is "a separate process that isn't always provable" (wp.filecointldr.io, ?p=2090); PDP proves possession with Merkle challenges (docs.filecoin.io/provide-storage/pdp/about).
- Swarm: bandwidth cheques and postage stamps; 1,304 of 1,649 staking nodes in Finland in June 2026 (ethswarm.org blog).
- Nym: "rewards from our finite mixmining pool do not match usage of the network" (nym.com/blog/nym-roadmap-2026); users pay with anonymous credentials.
- Orchid: probabilistic tickets on Ethereum; winning tickets can link a user to providers (Orchid whitepaper).
- Tor: 9,147 volunteer relays on 2026-10-26 (metrics.torproject.org); none of six incentive proposals deployed (blog.torproject.org, incentives research roundup).
- Fair exchange per chunk: Fair Data Exchange over Lightning uses KZG commitments and a SNARK, research only (arXiv 2506.14944).
- Metered relays: Cloudflare TURN $0.05/GB after 1,000 GB free; Twilio $0.40/GB in the US and Europe.
- MiCA: Norway's implementing act in force since 2025-07-01 (Schjødt); utility token definition in Art. 3(1)(9) (EUR-Lex 32023R1114). Paying relay operators in an existing token: not verified, needs a lawyer.
- Firefox Send was shut down over malware and phishing abuse (support.mozilla.org, what-happened-firefox-send).

## Business

- Merchant of record when charging starts: Stripe Managed Payments (3.5% plus 0.7% Billing, Norway supported, eligibility review), else Paddle (5% plus $0.50).
- Norwegian MVA registration above NOK 50,000 in 12 months; export treatment to confirm with an accountant.
- Analytics without cookies: Umami or Plausible. Turnstile is free. Build the DSA Article 16 notice form even though Norway's DSA bill is pending.
