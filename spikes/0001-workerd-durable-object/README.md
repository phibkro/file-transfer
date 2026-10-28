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
