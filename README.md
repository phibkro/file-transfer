# file-transfer (working name)

Send files of any size from your browser with one link, no install or account needed. Files are encrypted in the sender's browser and decrypted in the recipient's; the server in between carries ciphertext it can check but not read, and keeps no files. The whole system is free software (AGPL) that anyone can run: on their own Cloudflare account or on their own machine with one container.

Try it at https://send.phibkro.org (a demo instance with modest limits).

## Status

Working: end-to-end encrypted transfers, directly between browsers (WebRTC) when possible and through a relay otherwise, resume after a dropped connection, files up to at least 10 GB, renaming and sandboxed previews, operator limits. Also: opt-in counters with an operator page, self-hosting on workerd in one container, and one-click deploy to Cloudflare. Planned next: measuring direct transfers on real networks and phones, and encrypted storage for recipients who are offline. See [`docs/plan.md`](docs/plan.md) and [ADR 0019](docs/decisions/0019-open-source-first.md).

The parcel format has had two AI reviewer passes and is checked against an independent implementation in CI, but no human cryptographer has audited it yet. Read [`SECURITY.md`](SECURITY.md) before relying on it, and to report problems.

## Run your own

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/phibkro/file-transfer/tree/deploy)

The button deploys a prebuilt bundle (the `deploy` branch, built by CI) to your Cloudflare account. Or deploy from source:

On Cloudflare (the free plan is enough for personal use), with [Bun](https://bun.sh) 1.4 or later:

```
git clone https://github.com/phibkro/file-transfer
cd file-transfer
bun install
cd platforms/cloudflare
bun run build:all
bunx wrangler login
bunx wrangler deploy
```

Limits are variables in `platforms/cloudflare/wrangler.jsonc`; the site's "Run your own" page explains them. By default one network address may start 50 transfers an hour, one transfer may relay up to 25 GB, and the whole instance relays up to 100 GB a day.

### What Cloudflare's free plan carries

Estimates from Cloudflare's list prices and our load test ([spike 0003](docs/spikes/0003-relay-load.md)), not from an invoice. Cloudflare charges nothing for bandwidth; the relay is billed by Durable Object requests (20 incoming WebSocket messages count as one) and by duration. Only relayed transfers count: one that goes directly between browsers costs a handful of requests. The figures below assume every transfer is relayed. The allowance belongs to the Cloudflare account, so the instance shares it with any other Workers in that account.

| Per day on Workers Free             | About                                                       |
| ----------------------------------- | ----------------------------------------------------------- |
| Durable Object requests included    | 100,000                                                     |
| Requests per GB relayed             | 775                                                         |
| Relayed in total                    | 125 GB                                                      |
| Full-size transfers at the defaults | 5 of 25 GB, or 12 of 10 GB, or 1,200 of 100 MB              |
| Duration (13,000 GB-s)              | runs out first only if transfers average below about 1 MB/s |

When the day's requests are used up, rooms stop working for everyone on the instance until the allowance resets: new transfers cannot start, and transfers in progress stop. The per-address limits do not prevent this, since five full-size transfers from one person are enough. So Cloudflare deploys set a daily relay budget for the whole instance, `LIMIT_RELAYED_BYTES_PER_DAY`, to 100 GB: past it, transfers stop with a message and new ones are refused until 00:00 UTC, while the account keeps requests for everything else. On Workers Paid ($5 a month), the included million requests relay about 1,300 GB a month and more costs roughly $0.17 to $0.64 per TB, so there you can raise the budget or set it to `off`.

On your own machine, with Docker (amd64 or arm64; behind a proxy that terminates TLS; see [`platforms/self-hosted`](platforms/self-hosted/README.md)):

```
docker run -p 8080:8080 -v file-transfer-storage:/srv/storage ghcr.io/phibkro/file-transfer
```

Or as one program, without Docker: download `file-transfer-node` for Linux (x64, arm64), macOS (Apple silicon) or Windows from the [releases](https://github.com/phibkro/file-transfer/releases), then `mkdir storage && ./file-transfer-node`. Each release also carries the web client's static files. See [ADR 0021](docs/decisions/0021-distribution-web-client-and-server-node.md).

## Documents

- [`docs/design.md`](docs/design.md): requirements, planes, MVP architecture, transfer flow, pricing principles
- [`docs/parcel.md`](docs/parcel.md): parcel v1, the encrypted container every transfer moves (draft)
- [`docs/glossary.md`](docs/glossary.md): one meaning per term, in code and docs
- [`docs/plan.md`](docs/plan.md): phases, gates, milestones, metrics
- [`docs/decisions/`](docs/decisions/): architecture decision records
- [`docs/research.md`](docs/research.md): the findings and numbers behind the decisions
- [`CLAUDE.md`](CLAUDE.md): working rules for humans and agents

## Layout

```
libraries/     reusable client code: parcel, transport, sink, client
services/      declared subdomain models with in-memory reference layers
platforms/     layers implementing every service: cloudflare, self-hosted
integrations/  adapters to external systems: turn, captcha, analytics
apps/web       the user interface
spikes/        throwaway measurements for phase 0
```

## Development

Requires Bun 1.4 or later.

```
bun install
bun run check     # typecheck and tests
```

## Licence

AGPL-3.0, except `libraries/parcel`, which is MIT so other clients can implement parcels.
