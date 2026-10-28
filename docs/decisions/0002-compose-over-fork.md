# 0002 Compose existing code rather than fork one project

Status: accepted (2026-10-28)

## Context

No open-source project has live P2P, a relay, a key in the URL fragment, a Safari-proof save path and billing together, but between them every hard part exists under licences compatible with AGPL-3.0.

## Decision

Compose: SkySend for crypto and save tiers, transfer.zip as the live-pipeline reference, croc's stored-transfer design for phase 2, FilePizza's TURN credential pattern. Write only the relay, transport glue and the format ourselves (the format informed by SkySend, Send, RFC 8188 and age).

## Consequences

- Lifted code keeps its licence notices and is recorded in `docs/research.md`.
- SkySend is five months old with one vendor; its crypto is reviewed before it is trusted.
