# file-transfer (working name)

End-to-end encrypted file transfer in the browser: send a link, the recipient streams the file straight to disk while you are still sending it. Direct peer-to-peer when possible, a relay that only ever sees ciphertext when not. Open source (AGPL-3.0) and self-hostable.

Status: phase 0 (spike and format). Nothing here is usable yet.

## Documents

- [`docs/design.md`](docs/design.md): requirements, planes, MVP architecture, transfer flow, pricing principles
- [`docs/format.md`](docs/format.md): the encrypted object format v1 (draft)
- [`docs/plan.md`](docs/plan.md): phases, gates, milestones, metrics
- [`docs/decisions/`](docs/decisions/): architecture decision records
- [`docs/research.md`](docs/research.md): the findings and numbers behind the decisions
- [`CLAUDE.md`](CLAUDE.md): working rules for humans and agents

## Layout

```
libraries/     reusable client code: format, transport, sink, client
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

AGPL-3.0, except `libraries/format`, which is MIT so other clients can implement the format.
