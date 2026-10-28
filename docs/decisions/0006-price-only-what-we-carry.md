# 0006 Price only what we carry

Status: accepted (2026-10-28)

## Context

Throughput and latency are priced resources next to storage, but throttling a free tier below what the infrastructure delivers drew backlash before (RapidShare, 2012), and the product exists to fix artificially slow transfers.

## Decision

Direct peer-to-peer transfers run at full speed on every plan. Paid plans buy what we pay for: a relayed start from the first byte, uncapped and prioritised relayed throughput, relay placement between peers, EU jurisdiction for teams, and storage. The free relay cap is published as a number.

## Consequences

- `services/quota` owns plan entitlements, relay caps and priority.
- The free relay cap is set after M0 measures cost per relayed GB.
- EU jurisdiction is sold only after confirming Cloudflare's pricing and the fact that object IDs are logged outside the jurisdiction.
