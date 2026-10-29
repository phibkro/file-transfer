# 0019 Open source first: operators run instances, the hosted product comes later

Status: accepted (2026-10-29). Changes phase 1 in `plan.md`; ADR 0006 and ADR 0014 stay as they are, for the hosted product later.

## Context

The plan launched one hosted service (send.phibkro.org) with fake doors to test willingness to pay. The product owner proposed starting instead as a purely open-source system: anyone deploys it into their own Cloudflare account or hosts it themselves, and productification starts once use grows. Limits, telemetry and an administrative dashboard (observability, analytics, configuration) remain useful, now for whoever runs an instance.

Facts checked in Cloudflare's documentation on 2026-10-29:

- Durable Objects with the SQLite backend are on the Workers Free plan since 2025-04-07 (changelog). Free allows, per day, 100,000 requests, 13,000 GB-s of duration, 5 million rows read, 100,000 rows written and 5 GB of storage, and operations past a limit fail until 00:00 UTC (durable-objects/platform/pricing, /limits).
- Incoming WebSocket messages count as requests at 20 to 1, outgoing messages and protocol pings are free, and a hibernating object is not billed for duration (durable-objects/platform/pricing). By our arithmetic, a relayed GiB in 64 KiB records is 16,384 incoming messages, about 820 billed requests, so a free account relays on the order of 100 GB a day before the request limit. Active duration (about 28 hours of awake objects a day at 128 MB) is the other ceiling.
- Workers Paid is $5 a month and includes 1 million Durable Object requests and 400,000 GB-s a month; Workers bill no egress or bandwidth (workers/platform/pricing).
- The Deploy to Cloudflare button (`deploy.workers.cloudflare.com/?url=<repository>`) provisions Durable Objects from the Wrangler configuration, needs a public GitHub or GitLab repository, and "does not fully support monorepos": a subdirectory must be self-contained, dependencies included (workers/platform/deploy-buttons).
- Turnstile is free with unlimited verifications but each widget lists its hostnames, so every operator would register their own (turnstile/plans, /additional-configuration/hostname-management).
- Cloudflare Access can protect a path on a hostname; protecting a Worker as a whole does not support WebSocket upgrades (workers/configuration/cloudflare-access).

## Decision

1. **Three ways to run an instance**, all from the same code and passing the same conformance suites:
   - **Deploy to Cloudflare:** CI publishes a prebuilt, self-contained bundle (static assets, the bundled Worker, `wrangler.jsonc`) to its own small repository, which the button points at. Nothing is built at deploy time.
   - **Alchemy from this repository**, as today (`platforms/cloudflare/README.md`).
   - **Self-hosted on workerd** (`platforms/self-hosted`): a Docker image first, a Nix module after.
2. **Operator is a role, not an account.** Whoever runs an instance is its operator. They set its limits and see its counters on `/admin`, which accepts a secret chosen at deploy (`ADMIN_TOKEN`) and can additionally sit behind Cloudflare Access. People who send and receive still have no accounts; the accounts gate (phase 2) is unchanged.
3. **Limits are operator configuration with safe defaults.** The room server enforces them: rooms created per client address per hour (default 50, since many people share an address behind carrier NAT; amended 2026-10-29 from 20 to 100, then to 50), relayed bytes per room (default 25 GB, from 10 GB on 2026-10-29), and optionally Turnstile on room creation. The server cannot see a parcel's size (it is in the sealed manifest), so it enforces relayed bytes; the app reads the limits from `GET /api/limits` and warns before sealing a parcel that would exceed them. Defaults keep a free account inside its daily budget during a small abuse burst.
4. **Counters only, kept by the instance, and off unless the operator opts in** (amended 2026-10-29: analytics and telemetry are opt-in, with the default set per instance). Aggregate counts in hourly buckets (rooms created, recipients joined, transfers completed and failed by reason, relayed bytes, size buckets) are kept in a SQLite-backed Durable Object, so the same code runs on workerd. Never names, keys, link fragments, room identifiers or addresses (`services/telemetry`). Client addresses used for limits are salted and hashed and live only as long as their window.
5. **Nothing phones home.** An instance sends nothing to this project. Counting instances, if ever, is a separate, opt-in decision.
6. **send.phibkro.org stays as the public demo** with tight limits, so people can try before deploying.
7. **The hosted product waits for adoption.** Paid relay priority, the store and teams (ADR 0006, ADR 0014) come after the adoption gate, on the same code. AGPL means hosted forks share their changes.

## Consequences

- Phase 1's gate measures adoption instead of willingness to pay: proposed starting hypotheses are GitHub stars, outside issues and pull requests, and the demo instance's completion rate (at least 97%), with numbers fixed before launch. Whether people would pay stays untested until the hosted product; that is the price of this order.
- Every operator feature needs a reference layer and conformance suite in `services/*` and layers in both platforms (CLAUDE.md, package kinds).
- Fewer, larger WebSocket messages stretch the free budget: packing several records per frame (plan, M2) matters more now.
- Turnstile is opt-in per instance, since it needs the operator's own site key and hostname.
- The landing page becomes the repository's README and documentation: how to deploy, what an operator sees, and why relays carry only ciphertext.
