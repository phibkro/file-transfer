# platforms/self-hosted

The service on your own machine (docs/decisions/0004): the room Worker built from `platforms/cloudflare`, unchanged, on plain [workerd](https://github.com/cloudflare/workerd), Cloudflare's open-source runtime. A small assets Worker serves `apps/web`'s build the way Cloudflare's static assets do (clean URLs, the single-page fallback for `/r/<room>`, the rules in `_headers`). Durable Objects keep their SQLite storage in `storage/`.

| File                  | Role                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `workerd.capnp`       | Services, sockets, Durable Objects and settings (environment variables, named as in `wrangler.jsonc`) |
| `src/assetsWorker.ts` | Static files from workerd's disk service, with content types, caching and `_headers`                  |
| `src/assetRouting.ts` | The pure rules: clean URLs, fallback, content types, `_headers` parsing and matching                  |
| `Dockerfile`          | One container: build with Bun, run on `debian:bookworm-slim` with the workerd binary                  |

## Run it with Docker

```sh
docker run -p 8080:8080 -v file-transfer-storage:/srv/storage ghcr.io/phibkro/file-transfer
```

Or build it yourself from the repository root: `docker build -f platforms/self-hosted/Dockerfile -t file-transfer .`

Put a TLS-terminating proxy in front (Caddy, Traefik, nginx): browsers only allow the app's encryption and storage APIs on HTTPS (or `localhost`). Set `CLIENT_ADDRESS_HEADER` to the header your proxy writes the client's address into (for example `x-real-ip`); without it every client shares one hourly allowance of rooms.

## Settings

Environment variables, all optional:

| Variable                           | Default            | Meaning                                      |
| ---------------------------------- | ------------------ | -------------------------------------------- |
| `LIMIT_ROOMS_PER_ADDRESS_PER_HOUR` | 50                 | Rooms one client address may create per hour |
| `LIMIT_RELAYED_BYTES_PER_ROOM`     | 25000000000        | Bytes relayed for one transfer               |
| `CLIENT_ADDRESS_HEADER`            | `cf-connecting-ip` | Header holding the client's address          |
| `COUNTERS`                         | off                | `on` keeps aggregate counts (ADR 0019)       |
| `COUNTERS_RETENTION_DAYS`          | 90                 | Days of hourly counts to keep                |
| `ADMIN_TOKEN`                      | unset              | Opens `/admin` and `/api/admin/*`            |
| `ADDRESS_SALT`                     | unset              | Secret mixed into address hashes             |

## Without Docker

```sh
bun install
cd platforms/self-hosted
bun run build    # builds apps/web and the Worker, copies them here
bun run start    # workerd on port 8080
```

`bun run integration` runs `platforms/cloudflare`'s integration check against this platform; CI also runs the whole end-to-end suite against the container.
