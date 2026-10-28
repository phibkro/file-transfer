# platforms/self-hosted

The same service declarations as `platforms/cloudflare`, self-hosted (docs/decisions/0004):

- One box: the same Worker and Durable Object code on workerd.
- Several machines: the same code on celld, with SQLite replicated to an S3-compatible bucket.
- Bun layers only for a service where workerd or celld fall short.
- coturn for the WebRTC NAT fallback; Docker image and Nix module.

Built in M3, once M0 confirms the Cloudflare code (hibernation and Effect included) runs on workerd unchanged. Done means every service's conformance suite passes against these layers.
