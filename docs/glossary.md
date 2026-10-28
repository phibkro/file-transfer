# Glossary

One meaning per term, used the same way in code, docs and conversation. Code names are the full words below (CLAUDE.md, naming). If a new concept needs a word, add it here first.

## The thing that moves

| Term            | Meaning                                                                                                                                                                                                                                             | In code                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Parcel          | The encrypted, authenticated container a sender seals and recipients open: header, manifest records, then label pages each followed by the data records they cover. The same bytes travel direct, relayed or stored. Specified in `docs/parcel.md`. | `libraries/parcel`                             |
| Contract        | What a parcel promises, sealed and sent before any content: the header and the manifest records (manifest, record count, root). A changed promise is a new contract with the next sequence number (ADR 0012).                                       | `Contract`, `ReceivedContract`, `sealContract` |
| Contract digest | SHA-256 over the header and manifest records as sent; what a recipient's acceptance names.                                                                                                                                                          | `digest`                                       |
| Header          | The parcel's 58 plaintext bytes: magic, version, record size exponent, sequence number, salt, key commitment. Bound to every record as associated data.                                                                                             | `Header`, `encodeHeader`, `decodeHeader`       |
| Manifest        | What the parcel contains: file names, sizes, media types and the total size, in one canonical JSON form. Sealed in the manifest stream of 4 KiB records together with the record count and the root.                                                | `Manifest`, `ManifestFile`                     |
| Record          | The unit of encryption and resume: one AES-256-GCM sealed block with a synthetic nonce. Data records carry `2^recordSizeExponent` plaintext bytes (the last may be shorter); manifest records carry 4 KiB. Product docs call a data record a piece. | `sealRecord`, `sealData`, `openData`           |
| Label           | A data record's RFC 6962 leaf hash, computed in the labelling pass before anything is sent.                                                                                                                                                         | `labelRecords`, `labelOf`                      |
| Labelling pass  | The sender's first pass: seal every data record once and keep only its label. Deterministic sealing makes the sending pass reproduce the same records.                                                                                              | `labelRecords`                                 |
| Root            | The RFC 6962 Merkle root over all labels, part of the contract. Lets recipients, stores and seeds verify each record without keys.                                                                                                                  | `rootHash`, `treeHash`                         |
| Label page      | Up to 1024 labels plus an audit path proving they belong to the root, sent in plaintext ahead of the records they cover.                                                                                                                            | `labelPage`, `verifyPage`                      |
| Breach          | A data record that differs from its label: the recipient stops at that record, discards provisional output and reports it. The sender's own check is `source-changed`.                                                                              | `label-mismatch`                               |
| Frame           | The unit a path carries: a record or page split (or several packed) to fit the path's message size. Not part of the parcel.                                                                                                                         | `Frame`, `frameRecord` (`libraries/transport`) |

## Keys and links (key plane)

| Term            | Meaning                                                                                                                         | In code                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Link secret     | 32 random bytes the sender creates per room; everything else derives from it. Lives only in the link fragment and on endpoints. | `createSecret`                         |
| Link            | `https://<host>/r/<roomIdentifier>#<link secret>`. The fragment (after `#`) never reaches a server.                             | `encodeLinkSecret`, `decodeLinkSecret` |
| Sequence number | A parcel's position (u32) among the contracts of one room; it selects the parcel secret.                                        | `sequence`                             |
| Parcel secret   | Derived from the link secret and a sequence number; seals exactly one parcel.                                                   | `deriveParcelSecret`                   |
| Room token      | Derived from the link secret; proves link possession to signaling and relays. Servers store only its SHA-256.                   | `deriveRoomToken`, `hashRoomToken`     |
| Key commitment  | A value in the header that ties the parcel to one parcel secret, checked before anything is decrypted.                          | `keyCommitment`                        |
| Salt            | 16 random bytes per parcel; defence in depth against a sender that reuses a sequence number.                                    | `createSalt`                           |

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

| Term          | Meaning                                                                                                                       | In code                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Transfer      | Moving one parcel from a sender to its recipients, over one or more paths.                                                    |                                    |
| Room          | The meeting point where endpoints of one transfer find each other; admits by room token, holds no keys.                       | `services/room`                    |
| Path          | One way bytes travel: direct (WebRTC between endpoints) or relayed (through a relay); stored later.                           | `PathKind` (`libraries/transport`) |
| Relay session | One relayed path inside a relay, with credit-based flow control.                                                              | `services/relay`                   |
| Credit        | Permission for the sender to push one more frame, granted by the recipient as it consumes frames; keeps relay memory bounded. | `grant`, `NoCreditAvailable`       |
| Sink          | Where a recipient writes plaintext: a save tier plus a resume bitmap.                                                         | `libraries/sink`                   |
| Save tier     | How the browser writes to disk: file picker, service worker download, or OPFS.                                                | `SaveTier`                         |
| Resume        | Continuing an interrupted transfer from data record `i` of the same contract; both sides check records against their labels.  | `ResumeBitmap`                     |

## Words we avoid

- "Format", for the parcel: it also means code formatting (`vp fmt`) and file formats.
- "Upload", for sending: live transfers never upload to a server; only the store (phase 2) receives a copy, and it is encrypted.
- "Envelope": cryptographers read "envelope encryption" as wrapping keys with keys.
