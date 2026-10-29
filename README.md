# file-transfer (working name)

Send files of any size from your browser with one link, no install or account needed. Files are encrypted in the sender's browser and decrypted in the recipient's; the server in between carries ciphertext it can check but not read, and keeps no files. The whole system is free software (AGPL) that anyone can run: on their own Cloudflare account today, on their own machine soon.

Try it at https://send.phibkro.org (a demo instance with modest limits).

## Status

Working: end-to-end encrypted transfers through a relay, resume after a dropped connection, files up to at least 10 GB, renaming and sandboxed previews, operator limits. Planned next: an operator dashboard, one-click deploy, self-hosting on workerd, and direct transfers between browsers (WebRTC). See [`docs/plan.md`](docs/plan.md) and [ADR 0019](docs/decisions/0019-open-source-first.md).

The parcel format has had two AI reviewer passes and is checked against an independent implementation in CI, but no human cryptographer has audited it yet. Read [`SECURITY.md`](SECURITY.md) before relying on it, and to report problems.

## Run your own

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

Limits are variables in `platforms/cloudflare/wrangler.jsonc`; the site's "Run your own" page explains them.

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
