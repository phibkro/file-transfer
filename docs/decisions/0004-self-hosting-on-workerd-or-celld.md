# 0004 Self-hosting on workerd or celld, Bun as fallback

Status: proposed, confirmed by M0 (2026-10-28)

## Context

Self-hosting must not require rewriting the Durable Object-based platform. workerd (Apache-2.0) runs Workers and Durable Objects on a single node; its README says it is not a hardened sandbox. celld (Deno, Apache-2.0, v0.1.0) runs them across machines with SQLite replicated to an S3-compatible bucket.

## Decision

`platforms/self-hosted` runs the same Worker and Durable Object code on workerd for one-box installs and on celld for multi-machine installs. Bun layers implement a service only where workerd or celld fall short.

## Consequences

- M0 must confirm our code, including WebSocket hibernation and Effect, runs on workerd unchanged.
- Location hints and jurisdictions are Cloudflare-only; self-hosted placement is the operator's choice of machines.
- celld becomes a production option only once two-host durability is proven.
