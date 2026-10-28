# integrations

Adapters to external runtime systems, behind ports that services declare. Each integration has one implementation per supported system; platforms choose which one to wire.

| Integration              | Implementations                                                                           | Milestone |
| ------------------------ | ----------------------------------------------------------------------------------------- | --------- |
| `turn`                   | Cloudflare Realtime TURN (ephemeral credentials), coturn (FilePizza's credential pattern) | M2        |
| `captcha`                | Cloudflare Turnstile, none for private instances                                          | M3        |
| `analytics`              | Umami, hosted or self-hosted                                                              | M3        |
| `object-storage` (later) | Cloudflare R2, any S3-compatible store                                                    | phase 2   |
| `payments` (later)       | Stripe Managed Payments, Paddle                                                           | phase 2   |
| `email` (later)          | magic-link sender                                                                         | phase 2   |
