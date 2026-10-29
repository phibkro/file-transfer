# The self-hosted platform (docs/decisions/0004): the room Worker built from platforms/cloudflare, unchanged, on plain
# workerd, with apps/web's build served by a small assets Worker. Durable Objects keep their SQLite storage in the
# `storage` directory. Settings come from environment variables, named as in platforms/cloudflare/wrangler.jsonc; an
# unset one takes the code's default. Terminate TLS in front of this (Caddy, Traefik, nginx) and set
# CLIENT_ADDRESS_HEADER to the header your proxy writes the client address into (for example x-real-ip).
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .roomWorker),
    (name = "assets", worker = .assetsWorker),
    (name = "files", disk = (path = "public", writable = false)),
    (name = "storage", disk = (path = "storage", writable = true)),
  ],
  sockets = [
    (name = "http", address = "*:8080", http = (), service = "main"),
  ],
);

const roomWorker :Workerd.Worker = (
  modules = [
    (name = "worker.js", esModule = embed "dist/worker.js"),
  ],
  compatibilityDate = "2026-10-01",
  # Ciphertext does not compress; permessage-deflate only burns CPU (docs/spikes/0001).
  compatibilityFlags = ["no_web_socket_compression"],
  durableObjectNamespaces = [
    (className = "RoomObject", uniqueKey = "file-transfer-room", enableSql = true),
    (className = "AdmissionObject", uniqueKey = "file-transfer-admission", enableSql = true),
    (className = "CountersObject", uniqueKey = "file-transfer-counters", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "storage"),
  bindings = [
    (name = "ROOMS", durableObjectNamespace = "RoomObject"),
    (name = "ADMISSION", durableObjectNamespace = "AdmissionObject"),
    (name = "COUNTER_STORE", durableObjectNamespace = "CountersObject"),
    (name = "ASSETS", service = "assets"),
    (name = "LIMIT_ROOMS_PER_ADDRESS_PER_HOUR", fromEnvironment = "LIMIT_ROOMS_PER_ADDRESS_PER_HOUR"),
    (name = "LIMIT_RELAYED_BYTES_PER_ROOM", fromEnvironment = "LIMIT_RELAYED_BYTES_PER_ROOM"),
    (name = "CLIENT_ADDRESS_HEADER", fromEnvironment = "CLIENT_ADDRESS_HEADER"),
    (name = "COUNTERS", fromEnvironment = "COUNTERS"),
    (name = "COUNTERS_RETENTION_DAYS", fromEnvironment = "COUNTERS_RETENTION_DAYS"),
    (name = "ADMIN_TOKEN", fromEnvironment = "ADMIN_TOKEN"),
    (name = "ADDRESS_SALT", fromEnvironment = "ADDRESS_SALT"),
  ],
);

const assetsWorker :Workerd.Worker = (
  modules = [
    (name = "assets-worker.js", esModule = embed "dist/assets-worker.js"),
  ],
  compatibilityDate = "2026-10-01",
  bindings = [
    (name = "FILES", service = "files"),
  ],
);
