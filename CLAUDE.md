# Working rules for agents

This repository builds an end-to-end encrypted file transfer service (brand name to be decided). Read `docs/design.md` before changing architecture and `docs/format.md` before touching anything that produces or consumes bytes on the wire.

## The one invariant

Only endpoints (sender and recipients) ever hold keys. Every server-side component handles ciphertext it can verify but not read. Never log, store, or transmit the URL fragment, keys, file names, or plaintext on any server path. A change that weakens this is wrong even if tests pass.

## Package kinds

Every package belongs to exactly one kind. Put new code in the right one.

| Kind | Directory | What belongs here | May import |
| --- | --- | --- | --- |
| Library | `libraries/*` | Developer-facing reusable source code for any client (format, transport, sink, client SDK) | other libraries, `effect` |
| Service | `services/*` | Implementation-independent subdomain models: an Effect service declaration (tag + interface), domain types, pure logic, an in-memory reference layer, and conformance tests | libraries, `effect` only; never a runtime or vendor API |
| Platform | `platforms/*` | Layers implementing every declared service on one runtime (`cloudflare`, `self-hosted`) | services, libraries, integrations, runtime APIs |
| Integration | `integrations/*` | Adapters to external runtime systems behind ports that services declare (TURN, captcha, analytics, later object storage, payments, email) | libraries, `effect`, vendor SDKs |
| App | `apps/*` | User-facing applications built on `libraries/client` (`apps/web`) | libraries |

Platforms are isomorphic: `cloudflare` and `self-hosted` provide a Layer for the same set of service tags. A platform is complete only when it passes every service's conformance suite.

## Conventions

- TypeScript, strict mode, ES modules, Bun workspaces. Effect 4 for services, layers, streams and errors.
- Names use full words: `RoomIdentifier`, not `RoomId`; `createRoom`, not `mkRoom`. Abbreviations only when unambiguous and universal (`url`, `http`, `id` inside compound protocol field names defined in `docs/format.md`).
- Errors are typed (`Data.TaggedError`), never thrown strings.
- No em-dashes in docs or comments; use commas or parentheses.
- Diagrams: top-to-bottom main axis, left-to-right secondary.

## Testing

- `bun test` runs everything. Each service has `test/conformance.ts` exporting a suite that takes a Layer; the reference layer and every platform layer must pass it.
- `libraries/format` is the irreversible core: every change needs test vectors and property-based tests (round trip, truncation, reordering, record swapping, wrong key). Do not change the v1 wire format after it is frozen; add versions instead.
- Prefer measuring to estimating: spikes live in `spikes/` and record results in `docs/spikes/`.

## Phase discipline

We are in the startup phase (see `docs/plan.md`). Prefer adopting or lifting existing code (credit it, keep licence notices) over writing new code, except for the format, key handling and verification, which we write small and test heavily. Do not add Rust, accounts, payments, or a store before their phase gate.

## Licences

AGPL-3.0 for everything except `libraries/format` (MIT, so other clients can adopt it). Code lifted from other projects keeps its notices; record the origin in a header comment and in `docs/research.md`.

## Commits

Small, descriptive commits. Run `bun run check` (typecheck + tests) before committing.
