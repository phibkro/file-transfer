# file-transfer server node

One executable: the room server (relay) with the web app built in. It is the same code as the container and the
Cloudflare deployment, run by workerd, Cloudflare's open-source runtime. Source, documentation and issues:
https://github.com/phibkro/file-transfer

## Run it

```
mkdir storage
./file-transfer-node
```

It listens on port 8080 on every interface and keeps room state in `./storage`. To change either:

```
./file-transfer-node --socket-addr http=127.0.0.1:9000 --directory-path storage=/var/lib/file-transfer
```

Browsers allow the app's encryption and storage only on HTTPS (or `localhost`), so put a proxy that terminates TLS in
front of it (Caddy, Traefik, nginx) and set `CLIENT_ADDRESS_HEADER` to the header it writes the client's address into,
for example `x-real-ip`.

On macOS, a downloaded executable is quarantined; allow it with `xattr -d com.apple.quarantine file-transfer-node`.

## Settings

Environment variables, all optional:

| Variable                           | Default          | Meaning                                                     |
| ---------------------------------- | ---------------- | ----------------------------------------------------------- |
| `LIMIT_ROOMS_PER_ADDRESS_PER_HOUR` | 50               | Rooms one client address may create per hour                |
| `LIMIT_RELAYED_BYTES_PER_ROOM`     | 25000000000      | Bytes relayed for one transfer                              |
| `LIMIT_RELAYED_BYTES_PER_DAY`      | off              | Bytes the node relays per UTC day                           |
| `CLIENT_ADDRESS_HEADER`            | cf-connecting-ip | Header holding the client's address; set it to your proxy's |
| `COUNTERS`                         | off              | `on` keeps aggregate counts, read at `/admin`               |
| `COUNTERS_RETENTION_DAYS`          | 90               | Days of hourly counts to keep                               |
| `ADMIN_TOKEN`                      | unset            | Opens `/admin` and `/api/admin/*`                           |
| `ADDRESS_SALT`                     | generated        | Secret mixed into address hashes; set only to choose it     |

## Licence

AGPL-3.0-only (LICENSE). If you change the code and let others use it over a network, offer them your source.
