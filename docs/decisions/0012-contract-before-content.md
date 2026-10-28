# 0012 Contract before content

Status: proposed (2026-10-28), from the product owner's direction; the parcel v1 revision (ADR 0011) must make room for it before v1 freezes.

## Context

The parcel already sends its header and manifest before any data, but nothing makes the recipient agree to them first, and nothing lets the recipient check a piece against a promise until the trailer at the very end. With deterministic sealing (ADR 0011, finding H1), a sender who edits the file mid-transfer produces pieces that are each validly sealed; only the final root reveals the change, after bytes were written. The product owner's principle: label and cut first, agree on a contract, then deliver; any deviation from the contract is a breach, whether the sender changed the file or a path tampered with it, and any change to the contract must be agreed again.

## Decision

1. **Labelling before sending.** The sender seals every piece once before the first piece leaves, recording each piece's label (the hash of its sealed bytes) and the Merkle root over all labels. Deterministic sealing means the sending pass reproduces exactly the labelled pieces, so nothing is stored in between.
2. **The contract.** A contract is the parcel header, the manifest (names, sizes, media types, total size), the piece size and count, and the root that commits to every label. The recipient learns all of this, sealed, before any content.
3. **Acceptance before content.** The recipient opens the contract, shows what is coming, and replies with an acceptance naming the contract's digest. Senders send no data piece before an acceptance of that exact contract; recipients drop any piece that arrives without one.
4. **Breach.** A piece whose seal fails, or whose label differs from the contract, is a breach: the recipient aborts, discards provisional output (ADR 0011, finding M5) and reports which piece and why. A sender that re-seals a piece for resume and gets a different label than its own contract knows its file changed, and stops rather than sending.
5. **Amendments are new contracts.** A contract never changes. Adding or changing files mid-transfer means proposing a new contract (a new parcel) that the recipient accepts or declines; a room can carry a sequence of contracts. Each parcel seals under its own secret derived from the link secret and the contract's sequence number, which keeps "a secret seals exactly one parcel" (finding M3).
6. **Corruption is detected and re-requested, not corrected in place.** Both paths already authenticate every packet (TLS 1.3 and DTLS records are AEAD-protected, RFC 8446 section 5.2; WebRTC data channels run SCTP over DTLS, RFC 8831), so random corruption surfaces as a dropped connection, which resume handles; deliberate tampering fails a seal or a label and cannot be repaired by redundancy an attacker can also alter. Erasure coding (for example RaptorQ, RFC 6330) is reserved for stores and seeds (phase 4), where fetching a missing piece again is expensive.

## Consequences

- The first piece waits for the labelling pass: about 21 s per 10 GB at the 481 MB/s sealing rate measured on a Ryzen 9 5950X (an estimate without disk reads; phones are unmeasured and belong in the M0 save-tier test). Small transfers are unaffected in practice.
- Labels cost 32 bytes per 64 KiB piece (0.05 %): about 4.9 MB for 10 GB and 24 MB for 50 GB. The contract carries the root; labels travel in pages ahead of the pieces they cover, each page checked against the root. The page layout is a parcel specification detail and must respect the manifest stream's size bound.
- Resume becomes "I hold pieces 0 to i-1 of contract X", and both sides can check that claim.
- Stores and seeds (phase 2 and 4) verify pieces against the same root without keys.
- Open: whether a "live" mode without the labelling pass is ever needed (only if M0 shows the pass is too slow on phones).
