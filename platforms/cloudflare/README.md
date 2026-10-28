# platforms/cloudflare

Layers implementing every declared service on Cloudflare Workers and Durable Objects. Built in M0 (spike harness) and M2 (production layers).

- Worker entry: static assets for `apps/web`, room creation (Turnstile-checked), TURN credentials, notice form endpoint.
- `RoomObject`: one Durable Object per room (PartyServer), WebSocket hibernation while waiting for peers; implements `services/room`.
- `RelayObject`: one Durable Object per relayed transfer, forwarding frames with credit-based flow control; implements `services/relay`.
- Quota, telemetry and abuse layers on Durable Object SQLite storage.

Done means: every service's conformance suite passes against these layers under workerd locally (`wrangler dev`), and the M0 load test results are recorded in `docs/spikes/`.
