/**
 * Deploys spike 0001 to Cloudflare to measure what loopback cannot: real-network throughput, whether the edge
 * negotiates WebSocket compression with browsers despite the flag, per-object limits under load, and billing.
 *
 * Run on your own machine (your Alchemy profile holds the Cloudflare credentials; nothing leaves it):
 *
 *   export SPIKE_ACCESS_TOKEN=$(openssl rand -hex 32)   # keep it; the clients need it too
 *   bun install && bun run deploy                        # prints the Worker URL
 *   bun run destroy                                      # removes the Worker and its Durable Object namespace
 *
 * Async style (prebuilt bundle, `bundle: false`), not an Effect-native Alchemy Worker, so the deployed code is
 * byte for byte the bundle measured on workerd and wrangler dev (ADR 0004, spike 0001). With `bundle: false` the
 * compatibility flags below are used exactly as declared. Pattern from job-index/infra/alchemy.run.ts and
 * occupational-health/deploy/alchemy.run.ts (same author).
 */
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

export default Alchemy.Stack(
  "FileTransferSpike0001",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage
    if (stage !== "spike") return yield* Effect.die(new Error(`spike 0001 deploys only to the "spike" stage, not "${stage}"`))

    const relay = yield* Cloudflare.Worker("Relay", {
      name: "file-transfer-spike-0001-relay",
      main: "./dist/worker.js",
      bundle: false,
      compatibility: { date: "2026-10-01", flags: ["no_web_socket_compression"] },
      workersDev: true,
      env: {
        RELAY_SESSIONS: Cloudflare.DurableObject("RelaySessions", { className: "RelaySession" }),
        // Resolved at deploy time from the environment and bound as a secret; deploy fails if it is unset.
        SPIKE_ACCESS_TOKEN: Config.Redacted("SPIKE_ACCESS_TOKEN"),
      },
      observability: { enabled: false },
    })

    return { url: relay.url, worker: relay.workerName }
  }),
)
