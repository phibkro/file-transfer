# 0003 Package kinds, Effect services, platform layers

Status: accepted (2026-10-28)

## Context

The service must run hosted on Cloudflare and self-hosted with the same behaviour, and later on other runtimes, without rewrites.

## Decision

Four package kinds plus apps:

- `libraries/*`: developer-facing reusable source code for any client.
- `services/*`: implementation-independent subdomain models, declared as Effect services (tag plus interface plus domain types), each with an in-memory reference layer.
- `platforms/*`: layers implementing every declared service on one runtime (`cloudflare`, `self-hosted`).
- `integrations/*`: adapters to external runtime systems behind ports the services declare.
- `apps/web`: the user interface on `libraries/client`, served by every platform.

## Consequences

- The Cloudflare and self-hosted declarations are identical; implementations differ.
- Each service ships a conformance suite (property-based) that runs against its reference layer and every platform layer. A platform is complete only when all suites pass.
- Services may not import runtime or vendor APIs.
