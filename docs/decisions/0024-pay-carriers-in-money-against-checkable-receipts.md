# 0024 Pay carriers in money, against receipts the parcel makes checkable

Status: accepted (2026-10-29). Builds on ADR 0006 (price only what we carry); nothing here is scheduled before the phase 2 gate (`plan.md`).

## Context

A relay or store carries ciphertext it cannot read for people it does not know, so a third party has no reason to run one unless it is paid. The product owner asked whether a token on a smart-contract network could pay such carriers and so make an open, privacy-preserving network of senders, recipients and paid intermediaries. Research on 2026-10-29 (sources in `research.md`, Incentives for intermediaries) found:

- The idea is well explored. Filecoin, Storj, Sia and Arweave pay for storage; Swarm and Orchid pay for bandwidth; Nym pays mixnet nodes; six Tor incentive designs (GoldStar, PAR, BRAIDS, LIRA, TEARS, TorCoin) stayed research.
- Payment works, but tokens were not what made it work. Storj, the system closest to ours (client-side encryption, paid operators), stopped paying operators in its token and pays in USDC. Filecoin used 7.6% of its capacity in 2023; Nym's 2026 roadmap says its rewards "do not match network usage".
- Three problems stay open whatever the currency: proof of delivery (a recipient can deny receipt; Filecoin calls retrieval "not always provable"), Sybil and self-dealing (a node relaying to itself to farm rewards), and payment trails that link sender, recipient and carrier (Orchid's on-chain tickets) unless payments use blind credentials (Nym, LIRA).
- A token offered in Norway falls under MiCA, in force there since 1 July 2025; whether paying relay operators in an existing token is covered is unclear without legal advice.
- Content delivery that nobody can inspect attracts abuse: Mozilla shut down Firefox Send over malware and phishing. The product owner does not want to run a network that delivers secret content with no accountable operator.

Our parcel format is the part with no prior art found: a record's label is the SHA-256 of the sealed record and contract-signed label pages chain the labels, so any relay or store can check every record it carries without a key. That is what an honest bill needs.

## Decision

1. **No token and no on-chain settlement.** Carriers are paid in money: the hosted service charges for relay bandwidth, priority and storage (ADR 0006), and pays its own infrastructure.
2. **Bill only verified bytes.** A relay or store counts a record only after it matched its label. Usage is reported per contract digest and record range, so a customer can audit a bill against the signed label pages without anyone holding a key.
3. **Receipts stay portable.** When billing is built (phase 2), usage receipts are signed records that name the contract digest and the records carried. The same receipt could later settle a third-party operator in a scoped network, through ordinary invoicing, without changing the parcel or the room protocol.
4. **What labels do not solve is written down, not assumed solved**: proof of delivery against a recipient who denies receipt, self-dealing by a carrier, and privacy of payment trails.

## Consequences

- No change to code now. The parcel and room protocols already carry what verified metering needs.
- The novelty to explain to contributors and reviewers is the parcel's verify-without-reading property and the room's explicit roles (sender, recipients, carriers), not an incentive scheme.
- A token remains possible as a settlement layer over the same receipts, but only by a new decision that answers MiCA, abuse handling and the three open problems.
