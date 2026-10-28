# Encrypted object format v1 (draft)

Status: draft for milestone M1. It freezes after an external review; after that, changes need a new version number, never an edit. Implemented in `libraries/format` (MIT).

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

UTF-8 JSON, at most one record long:

```json
{ "version": 1, "files": [{ "name": "xbox.zip", "size": 10000000000, "mediaType": "application/zip" }], "totalSize": 10000000000 }
```

Data records carry the files' bytes concatenated in manifest order; boundaries come from the sizes. Multi-file transfers that need a directory tree use `/`-separated relative names; names containing `..` or absolute paths are rejected by receivers.

### Trailer (plaintext of metadata record 1)

| Size | Field                                                             |
| ---- | ----------------------------------------------------------------- |
| 8    | data record count, big-endian                                     |
| 32   | `rootHash`: Merkle root over the data stream's ciphertext records |

Merkle tree (RFC 6962 shape): leaf hash `SHA-256(0x00 || ciphertextRecord)`, interior node `SHA-256(0x01 || left || right)`, splitting at the largest power of two below the leaf count. The sender computes it incrementally while streaming, so the first byte is never delayed. In phase 2, stores and seeds receive `rootHash` as public metadata so they can verify chunks without keys; recipients check that public value against this authenticated trailer.

## Receiver rules

1. Check magic, version and `recordSizeExponent` range; recompute `keyCommitment` and compare in constant time.
2. Decrypt and authenticate each record before releasing any of its plaintext to disk.
3. Treat end of input before a record with the final flag as truncation, and data after it as an error.
4. Verify the trailer's record count and `rootHash` against what was received.
5. Any failure aborts the transfer and discards unverified output.

## Transport framing (not part of the format)

Records are the unit of encryption and resume, not of transport. `libraries/transport` splits a ciphertext record into frames that fit the path (WebRTC data channels default to a 64 KiB maximum message, and a 64 KiB record is 65,552 bytes of ciphertext) and reassembles them. Resume asks for "data records from index i".

## Test vectors and tests (M1)

- Fixed vectors: given secret, salt and inputs, the exact header, each record, and the trailer, for sizes 0, 1, one record minus one, exactly one record, one record plus one, and three records with a short tail.
- Property tests: round trip for arbitrary sizes and record exponents; any single-bit flip, truncation, reordering, duplicated record, swapped data and metadata streams, or wrong secret is rejected.

## Open questions for review

- Record size default: 64 KiB (SkySend, Send) versus 1 MiB (Tink) for throughput; decided by the M0 spike.
- Whether `keyCommitment` in the header is sufficient, or the commitment should also bind the salt explicitly (it does implicitly through HKDF).
- Manifest size limit (one record) versus a multi-record manifest for very large file sets.
- Info string prefix `e2e-transfer/v1/` is brand-neutral on purpose; confirm before freezing.
