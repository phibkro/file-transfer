# 0022 Direct paths over WebRTC, with the relay as fallback

Status: accepted (2026-10-29). Implements the direct half of ADR 0013's path decision; builds on the room protocol (docs/protocol.md).

## Context

Every transfer went through the room's relay. The relay always works, but it costs the operator Durable Object requests (775 per GB relayed, about 125 GB a day on Workers Free, spike 0003) and caps a room at roughly 28 to 78 MB/s on Cloudflare. A direct path between the two browsers costs the server nothing per byte and is the project's stated default ("directly between devices when possible, through relays when not").

Facts this decision rests on, read 2026-10-29 from primary sources:

- **Message size.** RFC 8841 says a peer that states no `max-message-size` accepts 64 KiB; Chrome's dcSCTP advertises 256 KiB (`max_message_size = 256 * 1024`, webrtc.googlesource.com `net/dcsctp/public/dcsctp_options.h`), Firefox about 1 GiB (`DataChannelProtocol.h`). A unit is 64 KiB plus a 9-byte prefix, so it fits every browser that states a size, and `send()` throws a TypeError above `RTCSctpTransport.maxMessageSize` (W3C webrtc-pc), which the code checks first.
- **Send buffer.** Chrome and Safari throw `OperationError` once 16 MiB wait in a channel's send queue (libwebrtc `MaxSendQueueSize`, WebKit `RTCDataChannel.cpp`); `bufferedamountlow` fires when the buffer falls to `bufferedAmountLowThreshold`.
- **STUN.** Cloudflare's "STUN service at `stun.cloudflare.com` is free and unlimited" (developers.cloudflare.com/realtime/turn/faq/). Google's public STUN server has no terms beyond a 2014 list post saying it is for development.
- **TURN.** Cloudflare Realtime TURN lists $0.05 per GB after a free allowance (its pricing pages disagree on whether the 1,000 GB a month is free without the SFU), caps an allocation at about 50 to 100 Mbps, and relays IPv4 only. The room relay is cheaper per GB and has no such cap.
- **Privacy.** "A connection will always reveal the IP addresses proposed for communication to the corresponding party" (W3C webrtc-pc, "Revealing IP addresses"). Browsers hide local addresses behind mDNS names; the public (server-reflexive) address is not hidden.
- **How often direct works.** No current primary measurement was found; the one published figure (appear.in, 2017) relayed 17.7% of calls through TURN. Plan for the relay carrying a real share.

## Decision

1. **One reliable, unordered data channel** (`parcel`) per sender and recipient pair carries parcel units, in the same frames as the relay. Unordered, because the recipient already takes records in any order (ADR 0013), so a loss holds up nothing behind it; reliable, because a partly reliable channel would leave every loss to want lists, and no measurement shows that pays. Revisit both with the lossy-link measurement in plan.md M0.
2. **Signalling goes through the room** as a `signal` control message both ways, relayed unread and never stored. The sender offers whenever a recipient joins, so the two sides never offer at once. Control messages (`accept`, `credit`, `want`, `complete`) stay on the room's socket: they are few, and the room keeps presence.
3. **Relay first, then direct.** The contract and the first records go over the relay at once; the sender switches units to the channel the moment it opens, typically within a second. Nobody waits for a direct path. A channel that has not opened after 15 s is given up.
4. **Fallback is a fresh session.** When the channel closes mid-transfer, records in flight on it may be lost with the sender's credits, so the recipient accepts again through the room with what is missing, exactly as after a reconnect. A dropped socket, or the other side leaving, closes the channel; the next join builds a new one.
5. **Backpressure** stops sending while more than 1 MiB waits in the channel's buffer and resumes at 256 KiB, far below the 16 MiB at which browsers throw.
6. **STUN only, no TURN.** A pair that cannot connect directly uses the room's relay, which is cheaper and faster than TURN. The instance names its STUN servers (`STUN_URLS`, Cloudflare's by default) and can turn direct paths off (`DIRECT_CONNECTIONS=off`), at `GET /api/direct`.
7. **Each person can turn direct paths off** ("Direct connections" at the bottom of every page, kept in that browser), because a direct path shows the other side their network address and the relay does not. On by default, as the product promises; the privacy page explains the trade.
8. **Counting** (opt-in, ADR 0019): the recipient's `complete` carries `path` (`direct` when any record came over the channel), so the room can count `path-direct` against `path-relayed`. A direct transfer gets no size bucket, because the room learns a parcel's size only from what it relays.

## Consequences

- Measured locally (one machine, headless Chromium, 268 MB, one run each): 19.3 MB/s direct against 13.1 MB/s relayed through `wrangler dev`. Both are limited by the browsers' decryption and storage on one machine, not by the network; real numbers need two devices on real networks, which the throughput spike in plan.md M0 still owes.
- Firefox pages also connect directly (15.5 MB/s on the same test). Playwright's WebKit on Linux never opened a direct path and finished every transfer on the relay, as designed; real Safari on macOS and iOS is untested.
- The end-to-end suite checks that two Chromium pages connect directly and that a transfer with direct connections turned off stays on the relay; resume after a cut socket runs on the relay alone, and the half-open cut runs with a direct path open. Tests turn off mDNS hiding of local addresses, since multicast DNS is often missing on CI machines.
- Signalling adds a few control messages per transfer through the room (a few requests, against 775 per relayed GB).
- Not built: TURN for networks where neither direct nor WebSocket works (rare, since the relay runs over HTTPS); several channels or peer connections for long fat paths (a 2026 discuss-webrtc measurement found more peer connections helped at 20 ms delay); a "relay only" choice per transfer rather than per browser; native clients (ADR 0005).
