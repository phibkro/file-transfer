# Glossary

One meaning per term, used the same way in code, docs and conversation. Code names are the full words below (CLAUDE.md, naming). If a new concept needs a word, add it here first.

## The thing that moves

| Term      | Meaning                                                                                                                                                                                                                   | In code                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Parcel    | The encrypted, authenticated container a sender seals and recipients open: header, manifest record, data records, trailer. The same bytes travel direct, relayed or stored. Specified in `docs/parcel.md`.                | `libraries/parcel`                             |
| Header    | The parcel's 54 plaintext bytes: magic, version, record size exponent, salt, key commitment. Bound to every record as associated data.                                                                                    | `Header`, `encodeHeader`, `decodeHeader`       |
| Manifest  | What the parcel contains: file names, sizes, media types and the total size. Encrypted; padded to exactly one record.                                                                                                     | `Manifest`, `ManifestFile`                     |
| Record    | The unit of encryption and resume: one AES-256-GCM sealed block of `2^recordSizeExponent` plaintext bytes (the last data record may be shorter). Data records carry file bytes; the manifest and trailer are records too. | `sealData`, `openData`                         |
| Trailer   | The final record: data record count and root hash, sealed so a receiver can check nothing was dropped or swapped.                                                                                                         | `Trailer`, `sealTrailer`                       |
| Root hash | RFC 6962 Merkle root over the ciphertext data records. Lets stores and seeds verify chunks without keys (phase 2).                                                                                                        | `MerkleFrontier`, `merkleRoot`                 |
| Frame     | The unit a path carries: a record split to fit the path's message size. Not part of the parcel.                                                                                                                           | `Frame`, `frameRecord` (`libraries/transport`) |

## Keys and links (key plane)

| Term           | Meaning                                                                                                                             | In code                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Secret         | 32 random bytes the sender creates per transfer; everything else derives from it. Lives only in the link fragment and on endpoints. | `createSecret`                         |
| Link           | `https://<host>/r/<roomIdentifier>#<secret>`. The fragment (after `#`) never reaches a server.                                      | `encodeLinkSecret`, `decodeLinkSecret` |
| Room token     | Derived from the secret; proves link possession to signaling and relays. Servers store only its SHA-256.                            | `deriveRoomToken`, `hashRoomToken`     |
| Key commitment | A value in the header that ties the parcel to one secret, checked before anything is decrypted.                                     | `keyCommitment`                        |
| Salt           | 16 random bytes per parcel; separates the keys of two parcels sent under one secret.                                                | `createSalt`                           |

## People and nodes

| Term      | Meaning                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------ |
| Sender    | The endpoint that seals a parcel.                                                                |
| Recipient | An endpoint that opens it. A transfer may have several.                                          |
| Endpoint  | A sender or recipient: the only nodes that ever hold keys.                                       |
| Node      | Any participant. Roles: endpoint, relay, store, seed; one node may hold several (design R9).     |
| Relay     | A node that forwards ciphertext frames between endpoints live, without storing them.             |
| Store     | A node that keeps a parcel for later download (phase 2).                                         |
| Seed      | A node that serves parts of a stored parcel to other nodes, verified by the root hash (phase 4). |
| Network   | A declared set of relays, stores and seeds a transfer is allowed to use (design R10).            |

## Moving a parcel (data and control planes)

| Term          | Meaning                                                                                                                                 | In code                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Transfer      | Moving one parcel from a sender to its recipients, over one or more paths.                                                              |                                    |
| Room          | The meeting point where endpoints of one transfer find each other; admits by room token, holds no keys.                                 | `services/room`                    |
| Path          | One way bytes travel: direct (WebRTC between endpoints) or relayed (through a relay); stored later.                                     | `PathKind` (`libraries/transport`) |
| Relay session | One relayed path inside a relay, with credit-based flow control.                                                                        | `services/relay`                   |
| Credit        | Permission for the sender to push one more frame, granted by the recipient as it consumes frames; keeps relay memory bounded.           | `grant`, `NoCreditAvailable`       |
| Sink          | Where a recipient writes plaintext: a save tier plus a resume bitmap.                                                                   | `libraries/sink`                   |
| Save tier     | How the browser writes to disk: file picker, service worker download, or OPFS.                                                          | `SaveTier`                         |
| Resume        | Continuing an interrupted transfer from data record `i`; needs identical plaintext on the sender side (`docs/parcel.md`, sender rules). | `ResumeBitmap`                     |

## Words we avoid

- "Format", for the parcel: it also means code formatting (`vp fmt`) and file formats.
- "Upload", for sending: live transfers never upload to a server; only the store (phase 2) receives a copy, and it is encrypted.
- "Envelope": cryptographers read "envelope encryption" as wrapping keys with keys.
