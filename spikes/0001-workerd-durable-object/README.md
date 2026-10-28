# Spike 0001: workerd, Durable Object, Effect, loopback throughput

Results: `docs/spikes/0001-workerd-durable-object.md`.

```sh
bun install
./node_modules/.bin/esbuild src/worker.ts --bundle --format=esm --platform=neutral --target=es2022 \
  --external:cloudflare:workers --outfile=dist/worker.js
mkdir -p state/workerd-storage
./node_modules/.bin/workerd serve workerd.capnp            # plain workerd on 127.0.0.1:8787
./node_modules/.bin/wrangler dev --port 8788 --persist-to state/wrangler   # same bundle under wrangler

export NO_PROXY=127.0.0.1
bun clients/hibernation.ts ws://127.0.0.1:8787 direct 2 9 10 15
bun clients/pauseMidTransfer.ts ws://127.0.0.1:8787 attached 12
python3 clients/matrix.py "$(pgrep -f '^./node_modules/.bin/workerd serve')" ws://127.0.0.1:8787 1024 3 direct attached effect standard
bun clients/bunRelay.ts 8790                                # control: same protocol without workerd
```

Modes are chosen per connection with `?mode=direct|attached|effect|standard`. `worker-only` is a diagnostic that fails by design (cross-request I/O).

## Deploying to Cloudflare (real-network measurements)

Runs on your machine with your Alchemy profile; credentials never leave it. The deployed relay is public, so it requires a token.

```sh
nix-shell                                   # NixOS: pinned Bun 1.4, Node and git (shell.nix)
bun run setup                               # installs the workspace (the spike bundles services/relay) and the spike
bun run profile                             # once, only if you have no Alchemy Cloudflare profile yet
export SPIKE_ACCESS_TOKEN=$(bun run --silent token)
bun run deploy                              # stage "spike"; prints the Worker URL
export SPIKE_URL=wss://file-transfer-spike-0001-relay.YOUR-SUBDOMAIN.workers.dev   # from the deploy output
bun run measure                             # 1 GiB through the relay, prints one JSON line
bun run destroy                             # when done
```

The stack (`alchemy.run.ts`) uploads the same prebuilt `dist/worker.js` with `bundle: false`, so compatibility flags (`no_web_socket_compression`) are used exactly as declared.
