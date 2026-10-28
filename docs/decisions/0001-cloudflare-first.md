# 0001 Cloudflare developer platform first

Status: accepted (2026-10-28)

## Context

The startup phase optimises for time to evidence and near-zero fixed cost. The MVP needs static hosting, signaling, a relay that forwards ciphertext, and TURN.

## Decision

Host the MVP on Cloudflare: Workers static assets, a Durable Object per signaling room (PartyServer), a Durable Object per relayed transfer, and Cloudflare Realtime TURN.

## Consequences

- $5/month platform minimum; relay estimated at $0.3 to $2 per TB with no egress charge (to be measured in M0); TURN free up to 1,000 GB/month.
- Relay flow control must be credit-based in our protocol, because Durable Objects have no server-side drain API.
- Lock-in is limited by declaring services independently (ADR 0003) and by workerd and celld running Durable Object code (ADR 0004).
- Ask Cloudflare in writing before relaying multiple terabytes per month.
