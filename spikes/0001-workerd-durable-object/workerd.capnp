# Plain workerd, no wrangler: the self-hosted path of ADR 0004.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .relayWorker),
    (name = "storage", disk = (path = "state/workerd-storage", writable = true)),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8787", http = (), service = "main"),
  ],
);

const relayWorker :Workerd.Worker = (
  modules = [
    (name = "worker.js", esModule = embed "dist/worker.js"),
  ],
  compatibilityDate = "2026-10-01",
  # Ciphertext does not compress; permessage-deflate (default since 2023-08-15) only burns CPU. See docs/spikes/0001.
  compatibilityFlags = ["no_web_socket_compression"],
  durableObjectNamespaces = [
    (className = "RelaySession", uniqueKey = "spike-0001-relay-session", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "storage"),
  bindings = [
    (name = "RELAY_SESSIONS", durableObjectNamespace = "RelaySession"),
  ],
);
