# spikes

Throwaway code for phase 0 measurements. Results go in `docs/spikes/`, not here.

| Spike                         | Question                                                                                                    | Status                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `throughput`                  | Direct WebRTC versus Durable Object relay: MB/s against RTT for a 5 GB stream, per browser                  | not started                                        |
| `save-tiers`                  | Picker, service-worker stream and OPFS on Chrome, Firefox, Safari desktop, Android Chrome, iOS Safari       | not started                                        |
| `relay-load`                  | Sustained MB/s per Durable Object, slow-receiver behaviour, cost per GB                                     | not started                                        |
| `0001-workerd-durable-object` | Same Worker and Durable Object code, hibernation and Effect included, on workerd; loopback relay throughput | done: `docs/spikes/0001-workerd-durable-object.md` |
