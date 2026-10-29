# Room and relay protocol (MVP)

How endpoints find each other and move a parcel through a relay. The parcel itself is in `parcel.md`; terms are in `glossary.md`. The relay forwards bytes it cannot read: it checks room tokens and routes frames, nothing else (CLAUDE.md, the one invariant).

Status: draft for the MVP. Codec in `libraries/transport/src/protocol.ts`.

## Rooms

- `POST /api/rooms` with JSON `{"roomTokenHash": <64 hex>, "maximumRecipients": <1..16>}` creates a room and answers `201 {"roomIdentifier": <22 base64url characters>}`. The server stores only the hash.
- Link: `https://<host>/r/<roomIdentifier>#<base64url(linkSecret)>`. The fragment never reaches a server.
- `GET /api/rooms/<roomIdentifier>/socket` upgrades to a WebSocket. Each room is one Durable Object (`idFromName(roomIdentifier)`).

## Socket messages

Text frames are JSON control messages; binary frames are parcel units. The first message on a socket must be `join`; the room answers `joined` or closes the socket with `error`.

| Message    | Direction           | Fields                                                                              | Meaning                                                                                        |
| ---------- | ------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `join`     | endpoint to room    | `role` (`sender` or `recipient`), `roomToken` (64 hex)                              | Admission: the room compares SHA-256 of the 32 token bytes with the stored hash, constant time |
| `joined`   | room to endpoint    | `participantIdentifier`, `senderPresent`, `recipientCount`, optional `answersPings` | Admitted; `answersPings` means the room answers liveness pings (below)                         |
| `peer`     | room to endpoint    | `event` (`joined` or `left`), `role`                                                | Presence changes                                                                               |
| `error`    | room to endpoint    | `reason`                                                                            | Then the room closes the socket                                                                |
| `accept`   | recipient to sender | `sequence`, `digest` (64 hex)                                                       | Acceptance of exactly this contract (ADR 0012)                                                 |
| `decline`  | recipient to sender | `sequence`                                                                          | Refusal; no content follows                                                                    |
| `credit`   | recipient to sender | `records` (1..4096)                                                                 | Permission for that many more data records                                                     |
| `want`     | recipient to sender | `sequence`, `ranges` (`[start, end)` pairs of data record indexes)                  | Missing records (ADR 0013); the sender answers each range with the covering label pages first  |
| `complete` | recipient to sender | `sequence`, optional `path` (`relay` or `direct`)                                   | Every record matched the contract; `path` says whether any came over a direct path             |
| `abort`    | either              | `reason`                                                                            | The transfer stops; the recipient discards provisional output                                  |
| `signal`   | either              | `description` (`type` offer or answer, `sdp`) or `candidate`                        | Sets up the direct path (below)                                                                |

The room relays `accept`, `decline`, `credit`, `want` and `complete` from recipients to the sender, and `abort` and `signal` both ways, without reading them, except that a `complete` with `path` is counted when the operator turned counting on. Binary frames on the socket flow only from the sender to recipients.

### Direct path

When both endpoints allow it (`GET /api/direct` for the instance, a setting for the person), the sender sets up a WebRTC data channel to the recipient (ADR 0022):

- The sender offers whenever a recipient joins; the recipient answers. Offers, answers and ICE candidates travel as `signal` messages through the room, which neither reads nor stores them. ICE servers are STUN only, from `GET /api/direct`.
- The data channel (`parcel`, reliable and unordered) carries parcel units in the same 9-byte-prefixed frames as the socket. Control messages always go through the room.
- Once the channel opens, the sender sends units over it; until then, and whenever it closes, over the socket. Credits apply to both. Units go back to the socket when a frame exceeds the channel's `maxMessageSize`.
- When the channel closes mid-transfer, the recipient sends `accept`, `want` with what is missing and new `credit` through the room, as after a reconnect. A dropped socket, or the other side leaving, closes the channel; the next join sets up a new one.

### Reconnecting

A reconnecting endpoint usually joins before the room has noticed its old socket is gone, and after a network change the room may never notice (a half-open socket). So the newest valid join wins:

- When a join's role is at capacity (one sender, or `maximumRecipients` recipients), the room evicts the oldest participant of that role, sends it `error` with reason `replaced by a newer connection` and closes it with code 4000. The other side hears `peer joined` for the newcomer and no `peer left` for the evicted socket.
- An endpoint that receives `error` stops rejoining, so two live tabs holding the same link cannot evict each other in a loop; the older tab simply stops.
- This grants nothing new: every holder of the link holds the room token and can join as either role. Rooms with several recipients will need recipient identities (a later phase) so that a new recipient does not evict another one.
- Close code 1012 (service restart) and any close without `error` mean "rejoin and resume". `scripts/endToEnd.ts` in `apps/web` cuts sockets both cleanly and half-open mid-transfer and checks the files still arrive byte-identical.

### Liveness

A socket can go silent without closing: a NAT forgets the connection, a phone moves from Wi-Fi to mobile data, a laptop sleeps. TCP may take many minutes to notice, and until then a transfer simply stops. So a room that says `answersPings: true` in `joined` answers the bare text frame `ping` (not JSON) with `pong`, and an endpoint:

- sends `ping` after 10 seconds without hearing anything on the socket, once per silence;
- after 20 seconds without hearing anything, gives the socket up (closing it with code 4001, which may never arrive) and rejoins as after any drop, then resumes from what is missing.
- before `joined` there is nothing to ping, so an endpoint whose socket has not opened and been answered with `joined` within 15 seconds gives it up the same way (code 4002) and joins on a new socket. This holds for every room, whether or not it answers pings.

On Cloudflare and workerd the runtime answers pings itself (`setWebSocketAutoResponse`), without waking the room's Durable Object. An endpoint ignores `pong` like any text frame it cannot decode, and does not ping a room that did not say `answersPings`, so older rooms and older endpoints work as before. `scripts/endToEnd.ts` in `apps/web` blackholes sockets mid-transfer in its chaos suite and checks the transfer recovers; it also blackholes a recipient's first socket before `joined` and checks the recipient joins again.

### Limits

The operator's limits (`platforms/cloudflare/src/limits.ts`, ADR 0019) end a room or refuse a new one with a reason the endpoint shows:

| Limit                                                 | Room creation (`POST /api/rooms`)                                              | In a room                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Rooms per client address per hour                     | 429 `{error: "rate limited", retryAfterSeconds}` with `Retry-After`            | none                                                                              |
| Relayed bytes per room                                | none                                                                           | `error` with `relay limit reached`, close code 4001; the room admits nobody again |
| Relayed bytes per UTC day for the instance (optional) | 429 `{error: "daily relay budget reached", retryAfterSeconds}` until 00:00 UTC | `error` with `daily relay budget reached`, close code 4002                        |
| A Durable Object the Worker could not reach           | 503 `{error: "temporarily unavailable"}` with `Retry-After: 1`                 | none                                                                              |

`GET /api/limits` answers `{roomsPerAddressPerHour, relayedBytesPerRoom, relayedBytesPerDay}`, the last `null` when the instance has no daily budget.

## Parcel units in binary frames

Each binary frame carries one unit: a 9-byte prefix, then the unit's bytes as `parcel.md` defines them.

| Offset | Size | Field                                                                                                              |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------ |
| 0      | 1    | kind: `1` header, `2` manifest record, `3` label page, `4` data record                                             |
| 1      | 4    | parcel sequence number, big-endian                                                                                 |
| 5      | 4    | index: `0` for the header, the counter for manifest records, the page for label pages, the record for data records |
| 9      | rest | the unit                                                                                                           |

## Order of a transfer

1. The sender labels the files, creates the room and shows the link.
2. Both join. The sender sends the header and manifest records (the contract) as soon as a recipient is present.
3. The recipient checks the key commitment, opens the contract, shows names and sizes, and answers `accept` with the digest, followed by `credit`.
4. The sender sends each label page before the records it covers, and one data record per credit. Units may arrive in any order; the recipient drops a record whose page it has not verified and asks for it again with `want`.
5. On a dropped connection (either side) the dropped endpoint rejoins; the sender offers the contract again as in step 2, and the recipient answers the same header with `accept` (same digest), then `want` with the ranges it still lacks, then `credit`.
6. When every record matched, the recipient sends `complete` and commits its files.

### Sender debt

Every `accept` starts a session in which the sender owes every record, in order, and holds no credit. A `want` that arrives after an `accept` and before that session's first `credit` replaces the debt with its ranges (resume: the recipient lists exactly what it lacks). A `want` that arrives later puts its ranges ahead of the rest of the debt (a dropped record). The sender resends the label pages covering any wanted range before the records. There is no "all sent" message: a recipient that sees no record arrive for a while, with records still missing and the sender present, sends `want` with what it lacks (`apps/web` waits 5 seconds).
