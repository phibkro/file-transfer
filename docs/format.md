# Encrypted object format v1 (draft)

Status: implemented and tested; draft until the external review in milestone M1. It freezes after that review; after that, changes need a new version number, never an edit. Implemented in `libraries/format` (MIT).

Design references: RFC 8188 record layout, the age STREAM construction (counter nonce plus final flag), SkySend's 64 KiB AES-256-GCM records, croc's stored-transfer design (associated data binding), RFC 6962 Merkle trees. Rationale is in `research.md`.

## Goals

- Stream encryption and decryption with constant memory, using WebCrypto AES-256-GCM in the browser (WebCrypto has no streaming AEAD).
- Detect truncation, reordering, record swapping, header tampering and wrong keys.
- Key commitment, so one ciphertext cannot decrypt validly under two keys ("invisible salamanders").
- The same bytes work for live, relayed and (phase 2) stored transfers, and later for multi-source download verified by a ciphertext Merkle root.
- Small enough to reimplement in Rust for native nodes, checked by shared test vectors.

## Secret and link

- The sender generates a 32-byte random `secret` (`crypto.getRandomValues`).
- Link: `https://<host>/r/<roomIdentifier>#<base64url(secret)>`. The fragment never reaches a server.

## Key derivation

All derivations use HKDF-SHA-256 with input keying material `secret`.

| Output          | Salt          | Info                         | Length | Use                                                                                                                                                |
| --------------- | ------------- | ---------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roomToken`     | empty         | `e2e-transfer/v1/room-token` | 32     | Proves link possession to signaling and relay. The sender registers `SHA-256(roomToken)` when creating the room; the server stores only that hash. |
| `contentKey`    | header `salt` | `e2e-transfer/v1/content`    | 32     | AES-256-GCM key for data records                                                                                                                   |
| `manifestKey`   | header `salt` | `e2e-transfer/v1/manifest`   | 32     | AES-256-GCM key for the manifest and trailer records                                                                                               |
| `keyCommitment` | header `salt` | `e2e-transfer/v1/commitment` | 32     | Stored in the header; the recipient recomputes it and compares in constant time before decrypting anything                                         |

Using separate keys for data and metadata streams means their nonce counters can both start at zero without reuse.

## Stream layout

```
header | manifest record | data record 0 .. data record n-1 | trailer record
```

Every length is known before the bytes arrive, so a receiver cuts the stream without delimiters: the header is 54 bytes; the manifest record is one full record plus its tag; the manifest's `totalSize` gives `n = max(1, ceil(totalSize / recordSize))` and each data record's length; the trailer is 56 bytes. Nothing may follow the trailer.

### Header (54 bytes, plaintext, authenticated as associated data of every record)

| Offset | Size | Field              | Value                                                                         |
| ------ | ---- | ------------------ | ----------------------------------------------------------------------------- |
| 0      | 4    | magic              | `0x45 0x32 0x45 0x01`                                                         |
| 4      | 1    | version            | `1`                                                                           |
| 5      | 1    | recordSizeExponent | plaintext record size is `2^n` bytes; default `16` (64 KiB); allowed 12 to 22 |
| 6      | 16   | salt               | random per transfer                                                           |
| 22     | 32   | keyCommitment      | derived as above                                                              |

### Records

- Cipher: AES-256-GCM, 16-byte tag. Ciphertext length is plaintext length plus 16.
- Nonce (12 bytes): 11-byte big-endian record counter followed by one flag byte, `0x01` for the last record of its stream and `0x00` otherwise.
- Associated data: the 54 header bytes.
- Two streams share the format:
  - Metadata stream under `manifestKey`: counter 0 is the manifest (flag `0x00`), counter 1 is the trailer (flag `0x01`).
  - Data stream under `contentKey`: counters `0 .. n-1`, all records exactly `2^recordSizeExponent` bytes of plaintext except the last, which has flag `0x01` and may be shorter. An empty transfer has a single empty final data record.

### Manifest (plaintext of metadata record 0)

The manifest record's plaintext is exactly one record (`2^recordSizeExponent` bytes): a 4-byte big-endian length, that many bytes of UTF-8 JSON, then zero bytes to the end. Receivers reject non-zero padding. The fixed length is what lets a receiver find where the manifest ends, and it hides how long the file names are. The JSON:

```json
{ "version": 1, "files": [{ "name": "xbox.zip", "size": 10000000000, "mediaType": "application/zip" }], "totalSize": 10000000000 }
```

Data records carry the files' bytes concatenated in manifest order; boundaries come from the sizes. Receivers validate strictly and reject the manifest if any of these fail:

- Exactly the keys shown: `version` (1), `files`, `totalSize` at the top; `name`, `size`, `mediaType` per file. Unknown keys are rejected, since new fields need a new version.
- `size` values are non-negative safe integers (below 2^53) and `totalSize` is their sum.
- Names are unique, `/`-separated relative paths: no empty segment (so no leading or trailing `/`), no `.` or `..` segment, no backslash, no control character (U+0000 to U+001F, U+007F). Receivers add their own platform rules (reserved names, length limits) when writing to disk.
- `mediaType` is a string; empty means unknown.

### Trailer (plaintext of metadata record 1)

| Size | Field                                                             |
| ---- | ----------------------------------------------------------------- |
| 8    | data record count, big-endian                                     |
| 32   | `rootHash`: Merkle root over the data stream's ciphertext records |

Merkle tree (RFC 6962 shape): leaf hash `SHA-256(0x00 || ciphertextRecord)`, interior node `SHA-256(0x01 || left || right)`, splitting at the largest power of two below the leaf count. The sender computes it incrementally while streaming, so the first byte is never delayed. In phase 2, stores and seeds receive `rootHash` as public metadata so they can verify chunks without keys; recipients check that public value against this authenticated trailer.

## Sender rules

- A fresh 16-byte random salt per transfer.
- Re-sealing a record for resume gives identical ciphertext only for identical plaintext. Two different plaintexts under one key and nonce break AES-GCM, so a sender that cannot be sure the source bytes are unchanged (the file was modified, or it cannot tell) starts a new transfer with a new salt instead of resuming.

## Receiver rules

1. Check magic, version and `recordSizeExponent` range; recompute `keyCommitment` and compare in constant time.
2. Decrypt and authenticate each record before releasing any of its plaintext to disk.
3. Treat end of input before the trailer as truncation, and any byte after the trailer as an error. The final flag is implied by the record index (`n - 1`), so a truncated stream fails authentication even if an attacker stops it at a record boundary.
4. Verify the trailer's record count and `rootHash` against what was received.
5. Any failure aborts the transfer and discards unverified output.

## Transport framing (not part of the format)

Records are the unit of encryption and resume, not of transport. `libraries/transport` splits a ciphertext record into frames that fit the path (WebRTC data channels default to a 64 KiB maximum message, and a 64 KiB record is 65,552 bytes of ciphertext) and reassembles them. Resume asks for "data records from index i".

## Test vectors and tests

- `libraries/format/test/vectors/vectors.json`: fixed secret and salt; the room token and its hash, the three derived keys, and for each case the header, manifest record, every data record, root hash and trailer. Cases: 0 bytes, 1 byte, one record minus one, exactly one record, one record plus one, three records with a short tail, two files plus an empty one (record size 2^12), and 1 byte at the default record size.
- `verify.py` next to it reimplements v1 from this document alone (Python, pyca/cryptography over OpenSSL, no shared code) and must reproduce every byte; CI runs it. `vectors.test.ts` fails if the TypeScript implementation drifts from the file.
- Property tests: round trip for arbitrary sizes, record exponents and chunking; rejection of any single-bit flip, truncation at any byte (`truncated` at every record boundary), trailing data, reordered or duplicated records, a data record swapped with the trailer, a record spliced from another transfer, the wrong secret, and a trailer with a wrong root or record count from a sender holding the keys.
- Merkle code is checked against the RFC 6962 roots for 1 to 8 leaves published in transparency-dev/merkle (`testonly/constants.go`).

## Open questions for review

- Record size default: 64 KiB (SkySend, Send) versus 1 MiB (Tink) for throughput; decided by the M0 spike.
- Whether `keyCommitment` in the header is sufficient, or the commitment should also bind the salt explicitly (it does implicitly through HKDF).
- Manifest size limit (one record) versus a multi-record manifest for very large file sets.
- Info string prefix `e2e-transfer/v1/` is brand-neutral on purpose; confirm before freezing.
- The header is bound twice: by the key commitment (which depends on the salt through HKDF) and as associated data of every record. No test can tell the second binding apart from the first, since any header change already fails the commitment or the length checks. Keep it as defence in depth, or drop it?
- The padded manifest costs one record per transfer (64 KiB at the default size). Acceptable, or should the manifest record use a smaller fixed size than data records?
- Manifest JSON serialisation is not canonical; receivers parse it, and only the vectors fix one byte form. Is a canonical form needed (for example for deduplication by stores in phase 2)?
