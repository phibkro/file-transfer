# 0024 Pay carriers in money, against receipts the parcel makes checkable

Status: accepted (2026-10-29). Builds on ADR 0006 (price only what we carry); nothing here is scheduled before the phase 2 gate (`plan.md`).

## Context

A relay or store carries ciphertext it cannot read for people it does not know, so a third party has no reason to run one unless it is paid. The product owner asked whether a token on a smart-contract network could pay such carriers and so make an open, privacy-preserving network of senders, recipients and paid intermediaries. Research on 2026-10-29 (sources in `research.md`, Incentives for intermediaries) found:

- The idea is well explored. Filecoin, Storj, Sia and Arweave pay for storage; Swarm and Orchid pay for bandwidth; Nym pays mixnet nodes; six Tor incentive designs (GoldStar, PAR, BRAIDS, LIRA, TEARS, TorCoin) stayed research.
- Payment works, but tokens were not what made it work. Storj, the system closest to ours (client-side encryption, paid operators), stopped paying operators in its token and pays in USDC. Filecoin used 7.6% of its capacity in 2023; Nym's 2026 roadmap says rewards from its mixmining pool "do not match usage of the network".
- Three problems stay open whatever the currency: proof of delivery (a recipient can deny receipt; a Filecoin guide calls retrieval "a separate process that isn't always provable"), Sybil and self-dealing (a node relaying to itself to farm rewards), and payment trails that link sender, recipient and carrier (Orchid's on-chain tickets) unless payments use blind credentials (Nym, LIRA).
- A token offered in Norway falls under MiCA, in force there since 1 July 2025; whether paying relay operators in an existing token is covered is unclear without legal advice.
- Content delivery that nobody can inspect attracts abuse: Mozilla shut down Firefox Send over malware and phishing. The product owner does not want to run a network that delivers secret content with no accountable operator.

What our parcel format gives an incentive layer, and what it does not (corrected 2026-10-29 after review of this record against `parcel.md`):

- A record's label is its RFC 6962 leaf hash, `H(0x00 || sealed record)`, and each plaintext label page carries up to 1024 labels plus a Merkle audit path to the root. So a carrier without the key can check that every record it carries matches a label, and that every label page proves to one and the same root.
- The root itself sits inside the sealed manifest (`parcel.md`, Manifest), as does the record count. A carrier without the key cannot tell that the root it computed is the contract's root. It can compute the contract digest (a hash over the header and the sealed manifest records it forwards), but nothing it can read ties that digest to the root.
- So, in parcel v1, a keyless carrier proves consistency, not contract membership. Tying the two together needs the key holder's word: the recipient, who checks every page against the sealed root, can sign a receipt naming the contract digest, the root and the records received. That receipt is what an honest bill needs.

## Decision

1. **No token and no on-chain settlement.** Carriers are paid in money: the hosted service charges for relay bandwidth, priority and storage (ADR 0006), and pays its own infrastructure.
2. **Bill only checked bytes, settled by receipts.** A relay or store counts a record only after it matched its label and its page proved to the transfer's root. Usage is settled against the recipient's receipt (contract digest, root, record ranges), so a customer can audit a bill without anyone else holding a key.
3. **Receipts stay portable.** When billing is built (phase 2), usage receipts are signed records that name the contract digest and the records carried. The same receipt could later settle a third-party operator in a scoped network, through ordinary invoicing, without changing the parcel or the room protocol.
4. **What labels do not solve is written down, not assumed solved**: binding a root to a contract without the key (parcel v1 seals the root), proof of delivery against a recipient who denies receipt, self-dealing by a carrier, and privacy of payment trails.

## Consequences

- No change to code now. Billing needs a signed recipient receipt, which neither the parcel nor the room protocol has yet; it is phase 2 work.
- Open, for a future parcel version: put the root and the record count in the plaintext header, which the contract digest already covers and which reveal nothing the public label pages and record sizes do not. A keyless carrier could then check every record against the contract itself. Parcel v1 is not changed.
- The novelty to explain to contributors and reviewers is the parcel's check-without-reading property (consistency in v1, contract membership with the open change above) and the room's explicit roles (sender, recipients, carriers), not an incentive scheme.
- A token remains possible as a settlement layer over the same receipts, but only by a new decision that answers MiCA, abuse handling and the three open problems.
