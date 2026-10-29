# 0021 Distribution: a web client and a server node

Status: accepted (2026-10-29). Builds on ADR 0004 (self-hosting on workerd) and ADR 0019 (open source first).

## Context

The product owner wants two things people can download and run: a web client, and a server node that can act as a relay and, later, as storage. Until now the server shipped as a Cloudflare deployment (the Deploy to Cloudflare button) and as a container image for amd64 only. People without Docker, and people on arm64 machines (a Raspberry Pi, an Apple silicon Mac, an Ampere server), had no supported way to run a node.

workerd can embed a configuration and all of its code and data in a copy of its own executable (`workerd compile`, read from `workerd compile --help` 2026-10-28): "outputs a new binary ... that embeds the config and all associated Worker code and data as one self-contained unit". The compiled executable still accepts `--socket-addr` and `--directory-path`, so the port and the storage directory stay the operator's choice. Measured on Linux x64: 148 MB uncompressed, almost all of it workerd itself; it served the app, created a room and admitted a sender with nothing beside it but an empty storage directory (`scripts/smokeNode.ts`).

## Decision

1. **Two products.** The **web client** is the static app in `apps/web` (sender, recipient, previews, the operator page). The **server node** is the Worker and its Durable Objects (`platforms/cloudflare/src`) on any runtime: rooms and the relay today, encrypted storage for offline recipients in phase 2 (ADR 0014). A node serves the web client too, so one download is a working instance.
2. **Four ways to get a node**, all built from the same Worker bundle:
   - Cloudflare: the Deploy to Cloudflare button (the `deploy` branch) or `wrangler deploy` from source.
   - Container: `ghcr.io/phibkro/file-transfer` for linux/amd64 and linux/arm64. The image builds without emulation: the JavaScript builds on the build machine, and the target architecture's workerd comes from npm.
   - Executable: `file-transfer-node` for Linux x64 and arm64, macOS arm64 and Windows x64, attached to each GitHub release. `scripts/nodeConfig.ts` embeds the web app's files as data modules in place of the `public` directory, and `workerd compile` runs on a runner of each platform, because it attaches the configuration to the workerd binary that runs it. Each executable is smoke-tested on its own platform before release. On macOS, `codesign` refuses to re-sign a binary with the configuration attached ("main executable failed strict validation"), yet the compiled executable runs on the arm64 runner as built, so it ships unsigned.
   - Source: `bun run compile` in `platforms/self-hosted`, or `workerd serve workerd.capnp`.
3. **The web client is also released on its own**, as a tarball of the static build, for people who want to host or audit the exact files. Served from another origin it cannot yet reach a node: it calls `/api` on its own origin. Choosing a node (and the networks a transfer may use, from the project description) is later work with its own decision.
4. **Releases come from version tags** (`.github/workflows/release.yml`): executables with checksums, the web client, and the container tagged with the version. Main keeps publishing `latest` and the commit's image.
5. **macOS on Intel is not built yet**: workerd publishes a binary for it, but the release needs an Intel macOS runner to compile on. The container covers Intel Macs meanwhile. Other architectures have no workerd binary.

## Consequences

- One executable per platform, about 150 MB uncompressed. The size is workerd's; the app adds about 1 MB.
- Anything that changes `workerd.capnp` must keep the files service line `scripts/nodeConfig.ts` replaces; the script fails loudly when it cannot find it.
- Executables are not notarised (macOS) or signed (Windows), so both operating systems warn on first run. Signing needs paid developer accounts; revisit when there are users who need it.
- The node's storage role (phase 2) arrives as more Durable Objects in the same Worker, so every distribution gains it without a new artifact.
