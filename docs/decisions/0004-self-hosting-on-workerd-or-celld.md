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

## Notes, 2026-10-29: scaling one install

Checked against upstream sources while spike 0003 ran:

- One workerd process serves on one thread. Its maintainer wrote "Currently workerd uses only a single thread, so to utilize multiple cores you would need to run multiple instances" (https://github.com/cloudflare/workerd/issues/72, 2022), and `src/workerd/server/AGENTS.md` still describes one event loop on a `current_thread` runtime. Locally, four rooms on one process carried about 87 MB/s each over loopback (spike 0003), so one process already saturates a 1 Gbit/s link.
- Durable Objects in workerd are local to one process: `workerd.capnp` says "TODO(someday): Support distributing objects across a cluster. At present, objects are always local to one instance of the runtime." Nothing documents two processes sharing one `storage` directory, and we found nothing in the code that would coordinate object ownership between them, so each process gets its own. An upstream cluster mode (https://github.com/cloudflare/workerd/pull/6780) assumed a shared filesystem and appears not to have been merged.
- celld is at v0.6.3, still beta (https://github.com/denoland/celld/blob/main/docs/limitations.md). It needs a bucket even for one node in fleet mode, and a single node "waits for the bucket on every write". It publishes no figures for high-throughput WebSocket forwarding.

So, for the relay: rooms share nothing, so an install scales by running more identical workerd processes (or machines) and routing each room to the process that created it. That needs the room identifier to name its process, which is a small change to room creation and the proxy in front, made when an operator outgrows one process. Rate limits and counters then live per process (limits loosen by the number of processes; Prometheus sums the counters). celld's replication and placement buy durability and failover that a room, which lives for one transfer and keeps nothing, does not need, and its output gate costs latency on every write. celld fits the later store phase (offline delivery), where objects hold state that must survive a machine; its spike belongs to that phase.
