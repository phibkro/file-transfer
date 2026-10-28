# 0017 Nearby rooms, knocking, and admission by short code

Status: proposed (2026-10-28), not scheduled. Builds on the PAKE short codes planned for phase 4 (`design.md`, Evolution).

## Context

The product owner's idea: clients on the same network can discover rooms, without any parcel being advertised. A room shows only that it exists, with a code; joining it "knocks", and the room's owner explicitly admits the knocker as a recipient or as a sender.

Facts checked on 2026-10-28:

- A web page cannot discover devices on the local network. Multicast and raw sockets exist only in Chrome's Direct Sockets API for Isolated Web Apps (developer.chrome.com/docs/iwa/direct-sockets). Chrome 142 and Firefox 153 put a permission prompt in front of requests from public pages to local addresses (developer.chrome.com/blog/local-network-access; WICG Local Network Access draft; Mozilla support article). WebRTC hides local addresses behind random `.local` names.
- Snapdrop and PairDrop therefore approximate "same network" on the server, by grouping clients with the same public IP address (`server/index.js` in Snapdrop; `server/peer.js` in PairDrop, which also maps private addresses together and can truncate IPv6 to a /64). PairDrop's own docs warn that a missing `X-Forwarded-For` makes every client visible to every other. By the same logic, clients behind one carrier-grade NAT or VPN exit share an address and would see each other; no source states this outright, it follows from the code.
- PairDrop adds public rooms entered by a 5-letter code or QR code, and persistent pairing by a 6-digit code (github.com/schlagmichdoch/PairDrop, README).
- magic-wormhole uses a short code (`7-crossover-clockwork`, 16 bits by default) as the password of a SPAKE2 exchange, so its relay server learns the key only by guessing the code in a man-in-the-middle attempt, one guess per use, and a wrong guess shows as an error (magic-wormhole.readthedocs.io, welcome and API pages).
- SPAKE2 is RFC 9382 (Informational, 2023). CPace (draft-irtf-cfrg-cpace-21) has been sent to the RFC Editor; it allows "at most one single password guess per active interaction". JavaScript implementations are young: `cpace-ts` 0.1.6 and `@cipherman/pake-js` 0.1.1 (CPace and SPAKE2+, checked against the draft's and RFC 9383's vectors, with the README asking for an independent audit before production); `@noble/curves` 2.4.0 has no PAKE.

## Proposal

1. **"Nearby" is a hint, never a security boundary.** A room may opt in to being listed to clients that share its public address (off by default). The listing shows the owner's chosen room label and a short code, nothing about parcels, sizes or names. Because shared addresses also join strangers (carrier NAT, VPNs, guest Wi-Fi), everything below must be safe even when the listing reaches people who are not nearby.
2. **Knocking.** A knock is a request to join a room, carrying the knocker's chosen display name and the role it asks for: recipient, or sender. The room relays it to the owner and admits nobody by itself. The owner admits as recipient, admits as sender, or refuses. A display name proves nothing, which is why admission rests on item 3.
3. **The short code authenticates the key, not just the room.** The code the owner's screen shows is the password of a balanced PAKE (CPace, or SPAKE2 as magic-wormhole uses) run between the knocker and the owner through the room. The exchange gives them a key the room server cannot learn without guessing the code, with one guess per attempt, and a failed guess is visible to the owner. Admission then sends the knocker what its role needs over that key: the link secret for a recipient, plus sequence numbers allocated by the owner for a sender (glossary, Room: two senders must never seal under one parcel secret). The server sees a knock, a role and an admission, never a key.
4. **Codes are short-lived and single-use per knock**, and the owner's screen shows a short confirmation string derived from the PAKE key that the knocker's screen also shows, so a mix-up between two knockers is visible before anything is shared.
5. **Links keep working.** A link (secret in the fragment) remains the way to share at a distance; nearby listing and codes are for the same room, in person.

## Consequences

- The PAKE is key handling: written small on `@noble/curves` (ristretto255) or adopted after vetting one of the young libraries against the CPace test vectors, and reviewed like the parcel. That is why this sits with phase 4's PAKE codes rather than the MVP.
- Listing by public address needs the room service to know clients' addresses, which it already sees; it must keep them only in memory for the listing and never log them.
- Senders admitted by knock make "one or more senders" (glossary, Room) real, and need the room to track which sequence numbers each sender holds.
- Direct WebRTC between devices on one network needs no local-network permission today, but Chrome's Local Network Access work may extend to it; watch before relying on local direct paths.
