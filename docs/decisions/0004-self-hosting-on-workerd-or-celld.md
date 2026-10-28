# 0004 Self-hosting on workerd or celld, Bun as fallback

Status: accepted for workerd (spike 0001, 2026-10-28); celld pending its own spike. Corrected 2026-10-28: celld is a Rust daemon, not Deno.

## Context

Self-hosting must not require rewriting the Durable Object-based platform.

- workerd (Apache-2.0) runs Workers and Durable Objects on a single node; its README says it is not a hardened sandbox. Spike 0001 ran the same bundle, hibernation included, on workerd and wrangler dev unchanged.
- celld (denoland/celld, Rust, Apache-2.0) runs Workers applications as "self-hosted, distributed Durable Objects" across machines, with each object's SQLite replicated to a bucket the operator owns. The house research (`/srv/share/projects/kwyne/docs/research/celld-and-prior-art.md`, 2026-10-03) records v0.6.1 beta and these constraints, citing celld's docs:
  - an output gate holds each response and each streamed chunk until a durability proof covers the writes it can reveal (confirmed on https://celld.dev/docs/guarantees);
  - Durable Object migrations accept only `new_sqlite_classes`; no rename, delete or jurisdiction;
  - only a fixed list of wrangler keys is accepted (no `routes`);
  - deploys move resident objects and close WebSockets with 1012; hibernated sockets close when a cell moves;
  - not safe for hostile multi-tenant use; one fleet runs one application.

## Decision

`platforms/self-hosted` runs the same Worker and Durable Object code on workerd for one-box installs and on celld for multi-machine installs. Bun layers implement a service only where workerd or celld fall short.

## Consequences

- The relay must not write storage per forwarded frame: on celld every write delays the frames that follow it until it is durable. Session state changes (credits, meters) are batched or kept in socket attachments, and whether attachments count as gated writes on celld is a question for the celld spike.
- Clients must treat close code 1012 as "reconnect and resume", which resume already requires.
- Location hints and jurisdictions are Cloudflare-only; self-hosted placement is the operator's choice of machines.
- celld becomes a production option only once a spike measures relay throughput under the output gate and two-host durability holds.
