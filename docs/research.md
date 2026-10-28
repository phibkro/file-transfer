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

| Origin                                                                               | Licence     | Into                    | What                                                      |
| ------------------------------------------------------------------------------------ | ----------- | ----------------------- | --------------------------------------------------------- |
| phibkro/vektorprogrammet-reimagined, machine module (its ADR 0007)                   | same author | `libraries/machine`     | Transition tables, `problems`, Mermaid output; simplified |
| phibkro/vektorprogrammet-reimagined, store-capability contract suites (its ADR 0014) | same author | `libraries/conformance` | Named guarantees, broken variants as negative controls    |
| phibkro/vektorprogrammet-reimagined, module-layer check (its ADR 0015)               | same author | `tools/quality`         | Module graph rules as data, with a check                  |

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

## Business

- Merchant of record when charging starts: Stripe Managed Payments (3.5% plus 0.7% Billing, Norway supported, eligibility review), else Paddle (5% plus $0.50).
- Norwegian MVA registration above NOK 50,000 in 12 months; export treatment to confirm with an accountant.
- Analytics without cookies: Umami or Plausible. Turnstile is free. Build the DSA Article 16 notice form even though Norway's DSA bill is pending.
