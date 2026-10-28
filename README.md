# file-transfer (working name)

Send files of any size from your browser with one link, no install or account needed. Files stream straight to the recipients' disks while you are still sending. They go directly between devices when possible, through relays when not, or through encrypted storage when recipients are offline. Only the sender and recipients can read the files or their names; relays and stores carry ciphertext they can check but not read. You choose which networks may carry your files, and anyone can run a node. The whole system is open source (AGPL) and free to self-host. The hosted service charges only for what it carries: relay bandwidth, speed priority and storage.

Status: phase 0 (spike and parcel specification). Nothing here is usable yet.

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
