# 0005 TypeScript first, Rust for native nodes

Status: accepted (2026-10-28)

## Context

Browsers and Cloudflare Workers run only JavaScript or WASM. WebCrypto's AES-GCM is native (5.67 GiB/s versus 94.8 MiB/s for pure-JS AES-GCM in the noble-ciphers benchmark), so moving encryption to WASM would not speed up the browser. iroh, the best QUIC P2P stack for native nodes, is Rust-only.

## Decision

TypeScript with Bun and Effect 4 for libraries, services, platforms, integrations and the web app. Rust enters in phase 4 for iroh native nodes and the CLI, as a second implementation of the format checked by the shared test vectors. A Rust crate compiles to WASM only if the browser must verify BLAKE3 blobs, after benchmarking BLAKE3 in WASM against WebCrypto SHA-256.

## Consequences

- `docs/parcel.md` and its test vectors, not either codebase, are the source of truth for the bytes on the wire.
- No Rust toolchain in the MVP.
- BEAM (strong for rooms and relays) was rejected because a BEAM platform would duplicate every service and cannot run on Workers.
