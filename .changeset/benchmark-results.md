---
---

Records the first benchmark results (docs/spikes/0004-transfer-benchmarks.md): encryption costs at most about 10 to 14% of a transfer on a 4 vCPU machine, larger records seal faster up to 256 KiB, and on one machine the relay outruns the direct path. Corrects ADR 0022's first comparison, which ran against a compressed relay. The benchmark now gives WebKit a persistent profile and measures 128 KiB records.
