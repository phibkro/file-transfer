# 0013 Order-free pieces, recipient-driven repair, path-agnostic transport

Status: proposed (2026-10-28), from the product owner's direction; builds on ADR 0012.

## Context

With every piece's label in the contract (ADR 0012), each piece can be checked on its own, so nothing in the parcel requires pieces to arrive in order or from one source. The product owner asked whether a UDP-based design that sends for throughput rather than careful sequencing would serve better than building on TCP, with the recipient asking for whatever is missing.

Prior art does exactly this: BitTorrent v2 (BEP 52: SHA-256 Merkle trees with 16 KiB leaves agreed in the metainfo, pieces fetched in any order from any peer), BLAKE3/Bao verified range streaming in iroh-blobs, Syncthing's index of block offsets and hashes, IPFS Bitswap's want lists with Have and DontHave answers, NORM (RFC 5740: NACK-driven repair), FLUTE/ALC with RaptorQ (RFC 6726, 5775, 6330: one-way delivery with fountain codes), and UDP bulk transports with selective retransmission (Aspera FASP, UDT).

Two constraints shape what a browser can do:

- Browsers expose no raw UDP. They expose WebRTC data channels (SCTP over DTLS over UDP; unordered with zero retransmits gives "a UDP-like service", RFC 8831) and WebTransport over QUIC (streams without ordering between them, datagrams that are never retransmitted, RFC 9000, RFC 9221), now in Chrome, Firefox and Safari 26.4. Cloudflare Workers and Durable Objects cannot terminate WebTransport, and Durable Objects speak WebSocket over TCP.
- Every one of these transports is congestion controlled underneath (RFC 8831 section 4; RFC 9221; ALC makes it a MUST). Sending faster than the path allows does not raise throughput; it raises loss for everyone, us included. TCP's real cost is not overhead but loss times round-trip time (throughput is bounded by about MSS / (RTT x sqrt(loss)), Mathis et al. 1997) and head-of-line blocking, where one lost packet stalls everything behind it. On clean links TCP fills the pipe; on lossy, long or mobile links, selective repair over UDP wins.

## Decision

1. **Pieces are order-free.** A recipient accepts any piece in any order, checks it against its label and writes it at its offset. Sinks that need order (the service-worker download tier) keep a bounded reorder buffer.
2. **Repair is recipient-driven.** The recipient keeps the set of pieces it holds (the resume bitmap) and sends want lists: "I am missing these". Today the sender answers; later stores and seeds may answer too, since they can check pieces against the same labels. Resume, path switches and multi-source fetching become one mechanism.
3. **Paths are chosen per network, not per design.**
   - Direct and TURN-relayed: WebRTC data channels, unordered, with limited or no retransmission, so our want lists do the repair and one loss never stalls the rest.
   - Server relay: the Durable Object WebSocket relay (TCP, ordered), which always works and is far cheaper per GB than TURN (Cloudflare TURN lists $0.05 per GB after 1,000 GB free and about 50 to 100 Mbps per allocation).
   - WebTransport is the candidate for a self-hosted relay, where we control the server.
4. **No blind duplicates.** Proactive redundancy, if any, is a fountain code (RaptorQ) sized from measured loss, not repeated pieces, and only on paths where M0 shows a repair round trip costs more than the redundancy.

## Consequences

- M0 gains a measurement: on a lossy link (phone hotspot), reliable ordered data channel versus unordered with zero retransmits plus our want lists.
- `libraries/transport` needs a want-list message and an unordered data-channel mode; `libraries/sink` already has the resume bitmap.
- Random-access writes exist where we need them: `FileSystemWritableFileStream.write({ position })` in Chrome, and the origin private file system (`FileSystemSyncAccessHandle`, offset writes) in every browser. Firefox and Safari have no save picker, so they write to the origin private file system first and export at the end.
