# Parcel v1 (draft)

A parcel is the encrypted, authenticated container every transfer moves: what a sender seals and recipients open, carried unchanged over direct, relayed and stored paths. Terms are defined in `glossary.md`.

Status: implemented and tested; revised after the first review (docs/decisions/0011); draft until that review's second pass. It freezes after that; after that, changes need a new version number, never an edit. Implemented in `libraries/parcel` (MIT).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

Design references: the age STREAM construction (counter nonce, final flag), synthetic initialisation vectors (Rogaway and Shrimpton, "Deterministic authenticated-encryption", 2006), RFC 5869 HKDF, RFC 6962 Merkle trees, RFC 8259 JSON, RFC 6838 media types, Microsoft's file naming rules. Rationale is in `research.md` and docs/decisions/0011.

## Goals

- Stream encryption and decryption with constant memory, using Web Crypto AES-256-GCM and HMAC-SHA-256 in the browser.
- Detect truncation, reordering, record swapping, header tampering and wrong keys.
- Key commitment, so one ciphertext cannot decrypt validly under two keys ("invisible salamanders").
- No nonce reuse even when a sender reseals a record whose plaintext changed (resume after an edit, a buggy client): nonces are synthetic.
- One accept set: every conforming receiver accepts and rejects exactly the same bytes, checked by shared positive and negative test vectors.
- The same bytes work for live, relayed and (phase 2) stored transfers, and later for multi-source download verified by a ciphertext Merkle root.

## Notation

- `||` is concatenation. `u8(x)`, `u32(x)`, `u40(x)`, `u64(x)` are unsigned big-endian integers of 1, 4, 5 and 8 bytes.
- `ascii("...")` is the ASCII bytes of a string, without a terminator.
- `HMAC(key, message)` is HMAC-SHA-256 (RFC 2104) with a 32-byte output.
- `first(n, bytes)` is the first `n` bytes.

## Secret and link

- The sender generates a 32-byte random `secret` from a cryptographically secure generator.
- Link: `https://<host>/r/<roomIdentifier>#<fragment>`, where `fragment` is the secret in base64url (RFC 4648 section 5) without padding: exactly 43 characters from `A-Z a-z 0-9 - _`. Receivers MUST reject any other length or alphabet, and any fragment that does not re-encode to itself (non-zero trailing bits). The fragment never reaches a server.
- **A secret seals exactly one parcel.** A sender MUST NOT create a second parcel (a second salt) under a secret; to send changed content it creates a new secret and link. A recipient that has accepted a header for a link MUST reject a different header for that link, including on resume.

## Key derivation

All keys come from one HKDF-SHA-256 extraction (RFC 5869 section 2.2) followed by expansions with distinct info strings:

```
prk = HMAC(ascii("parcel/v1"), secret)
expand(info) = HMAC(prk, info || u8(1))          (RFC 5869 T(1); 32 bytes)
```

| Output                 | Info                                                  | Use                                                                                         |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `roomToken`            | `ascii("parcel/v1/room-token")`                       | Proves link possession to signaling and relays. Servers store only `SHA-256(roomToken)`.    |
| `contentKey`           | `ascii("parcel/v1/content-key") \|\| salt`            | AES-256-GCM key of the data stream                                                          |
| `contentSyntheticKey`  | `ascii("parcel/v1/content-synthetic-key") \|\| salt`  | HMAC key for the data stream's synthetic nonces                                             |
| `manifestKey`          | `ascii("parcel/v1/manifest-key") \|\| salt`           | AES-256-GCM key of the manifest stream (manifest records and trailer)                       |
| `manifestSyntheticKey` | `ascii("parcel/v1/manifest-synthetic-key") \|\| salt` | HMAC key for the manifest stream's synthetic nonces                                         |
| `keyCommitment`        | `ascii("parcel/v1/key-commitment") \|\| salt`         | Stored in the header; recomputed and compared in constant time before anything is decrypted |

`salt` is the header's 16 bytes. No info string is a prefix of another, and the salt has a fixed length, so every pair of inputs to `expand` differs. Each output is used as raw key bytes (AES-256 key, HMAC key) or compared directly. In Web Crypto, `deriveBits` or `deriveKey` with `{ name: "HKDF", hash: "SHA-256", salt: ascii("parcel/v1"), info }` and a 256-bit length computes exactly `expand(info)`.

## Stream layout

```
header | manifest record 0 .. m-1 | data record 0 .. n-1 | trailer
```

The parcel has two record streams. The **manifest stream** (keys `manifestKey`, `manifestSyntheticKey`) holds the manifest records at counters `0 .. m-1` and the trailer at counter `m`. The **data stream** (keys `contentKey`, `contentSyntheticKey`) holds the data records at counters `0 .. n-1`. Every length is known before the bytes arrive, so a receiver cuts the stream without delimiters:

- the header is 54 bytes;
- each manifest record is `4096 + 23` bytes; manifest record 0 tells `m`;
- the manifest's `totalSize` gives `n = max(1, ceil(totalSize / R))` with `R = 2^recordSizeExponent`, and each data record's length;
- the trailer is `40 + 23 = 63` bytes. Nothing may follow it.

### Header (54 bytes, plaintext)

| Offset | Size | Field              | Value                                                                     |
| ------ | ---- | ------------------ | ------------------------------------------------------------------------- |
| 0      | 4    | magic              | `0x45 0x32 0x45 0x01`                                                     |
| 4      | 1    | version            | `1`                                                                       |
| 5      | 1    | recordSizeExponent | data record plaintext size is `2^n` bytes; default `16`; allowed 12 to 22 |
| 6      | 16   | salt               | random per parcel                                                         |
| 22     | 32   | keyCommitment      | derived as above                                                          |

### Records

Every record in both streams is sealed the same way. For a stream with keys `aeadKey` and `syntheticKey`, counter `i` (`0 <= i < 2^40`), final flag `f` (`0x01` for the last record of the stream, else `0x00`) and plaintext `P`:

```
synthetic = HMAC(syntheticKey, u64(i) || u8(f) || P)
nonce     = u40(i) || first(7, synthetic)
aad       = header || u64(i) || u8(f)
C || T    = AES-256-GCM-Encrypt(aeadKey, nonce, P, aad)      (16-byte tag T)
record    = first(7, synthetic) || C || T                     (|P| + 23 bytes)
```

A receiver knows `i` and `f` from the record's position. It rebuilds the nonce from `i` and the record's first 7 bytes, decrypts with `aad`, recomputes `synthetic` over the plaintext and compares its first 7 bytes with the record's in constant time; any mismatch is `authentication-failed`.

Why synthetic: the nonce depends on the plaintext, so resealing record `i` with the same plaintext gives the same bytes (resume and the Merkle root stay stable) and resealing it with different plaintext gives a different nonce (no AES-GCM nonce reuse). Two different plaintexts at one counter collide on the 7 synthetic bytes with probability about `2^-56` per pair, and nobody without `syntheticKey` can search for a collision. Records at different counters never share a nonce. The final flag is in the associated data, so a truncated stream cannot pass a non-final record off as final.

### Manifest

The manifest says what the parcel contains. Its encoding is canonical: one manifest has exactly one valid byte form.

**Canonical JSON.** UTF-8 without a byte order mark and without any whitespace outside strings:

```
{"version":1,"files":[{"name":N,"size":S,"mediaType":T},...],"totalSize":Z}
```

- Keys appear exactly once, in exactly this order; no other keys.
- Integers are decimal digits with no sign, no leading zero (zero is `0`), no fraction and no exponent.
- Strings are written with `"`; inside them `"` is `\"`, `\` is `\\`, U+0008, U+0009, U+000A, U+000C, U+000D are `\b \t \n \f \r`, other code points below U+0020 are `\u00` plus two lowercase hex digits, and every other code point is its literal UTF-8. (This is `JSON.stringify` and Python's `json.dumps(..., ensure_ascii=False, separators=(",", ":"))`.) Strings must be well-formed Unicode: no lone surrogates.

A receiver MUST decode the bytes as strict UTF-8, parse them, validate the result as below, re-encode it canonically, and reject the manifest (`invalid-manifest`) unless the re-encoding equals the received bytes exactly. That one rule rejects byte order marks, whitespace, duplicate or reordered keys, `1e3`, `1.0`, `-0` and unnecessary escapes.

**Validation.**

- `version` is `1`.
- `files` has at least one entry. (A parcel always carries at least one file; it may be empty.)
- `size` values are integers, `0 <= size`, and `totalSize` is their sum, `totalSize < 2^40` (1 TiB).
- `mediaType` is the empty string (unknown) or a lowercase media type of at most 127 bytes: `restricted-name "/" restricted-name` (RFC 6838 section 4.2), where `restricted-name` is a letter or digit followed by up to 126 of `a-z 0-9 ! # $ & ^ _ . + -`, with no parameters. Receivers MUST NOT use it to render content on the application's origin; they save files as downloads (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`).
- Every `name` follows the **name profile** below, and names are unique as defined there.

**Name profile.** Names are `/`-separated relative paths that every common file system can store without renaming:

1. The name is in Unicode Normalization Form C (NFC).
2. At most 4096 UTF-8 bytes; each `/`-separated segment is non-empty, at most 255 UTF-8 bytes, and neither `.` nor `..`. (So no leading, trailing or doubled `/`.)
3. No code point in General Category Cc (controls), Cf (format: bidirectional controls such as U+202E, zero-width characters, the byte order mark), Zl, Zp, or Cs (lone surrogates), as of Unicode 15.1, and none of `\ : * ? " < > |`.
4. No segment ends with `.` or U+0020 SPACE.
5. No segment is a Windows device name: its part before the first `.`, with trailing spaces removed and ASCII letters lowercased, is not `con`, `prn`, `aux`, `nul`, or `com` or `lpt` followed by one of `1`-`9`, `¹`, `²`, `³`.
6. Uniqueness: let `key(name)` be the NFC normalisation of the full Unicode default case folding (CaseFolding.txt statuses C and F, Unicode 15.1) of the name. No two files have the same key, and no file's key followed by `/` is a prefix of another file's key (a file cannot share a path with a folder).

Receivers that write to disk MAY apply further platform rules (path length limits, reserved names of their own) by renaming, never by writing outside the destination folder.

**Manifest stream plaintext.** Let `J` be the canonical JSON and `L` its length, `L <= 2^24 - 4`. The manifest stream's plaintext is `u32(L) || J || zero bytes`, padded to `m * 4096` bytes, where `m` is the smallest power of two with `m * 4096 >= 4 + L` (so `m <= 4096`). It is cut into `m` records of 4096 bytes at counters `0 .. m-1`, all with flag `0x00`. A receiver reads record 0, learns `L` and so `m`, reads exactly `m` manifest records, and rejects (`invalid-manifest`) unless every padding byte is zero. A sender that sends more manifest records than `m` makes the receiver read the extra record as data record 0, which fails authentication.

### Data records

Counters `0 .. n-1`; every record holds exactly `R` bytes of plaintext except the last (flag `0x01`), which holds `totalSize - (n - 1) * R` bytes: between 1 and `R`, or 0 only when `totalSize` is 0 (then `n = 1`). Data records carry the files' bytes concatenated in manifest order; boundaries come from the sizes.

### Trailer

The manifest stream's final record (counter `m`, flag `0x01`), with 40 bytes of plaintext:

| Size | Field                                                                                      |
| ---- | ------------------------------------------------------------------------------------------ |
| 8    | data record count `n`                                                                      |
| 32   | `rootHash`: Merkle root over the data records as sent (all 7 + `\|C\|` + 16 bytes of each) |

Merkle tree (RFC 6962 shape): leaf hash `SHA-256(0x00 || record)`, interior node `SHA-256(0x01 || left || right)`, splitting at the largest power of two below the leaf count. The sender computes it incrementally while streaming. In phase 2, stores and seeds receive `rootHash` as public metadata so they can verify records without keys; recipients check that public value against this authenticated trailer.

## Limits

| Quantity             | Limit                  |
| -------------------- | ---------------------- |
| `totalSize`          | `< 2^40` bytes (1 TiB) |
| data records `n`     | `<= 2^28` (implied)    |
| any record counter   | `< 2^40`               |
| canonical JSON `L`   | `<= 2^24 - 4` bytes    |
| manifest records `m` | `<= 4096`              |

The size limit keeps the AES-GCM confidentiality advantage per key near `2^-57` (draft-irtf-cfrg-aead-limits); product limits are lower (docs/design.md, R5).

## Sender rules

- A fresh 16-byte random salt per parcel, and one parcel per secret.
- Resume: the sender sends the identical header and manifest records again (they are deterministic given the secret, salt and manifest) and continues with data record `i`. It recomputes the Merkle frontier over records `0 .. i-1` from the current source, so if the source changed, the trailer's root no longer matches what the recipient received and the recipient discards the output. Transports SHOULD let the recipient send its root over records `0 .. i-1` so the sender can stop early when they differ.

## Receiver rules

1. Read the header; check magic, version and `recordSizeExponent`; derive the keys and compare `keyCommitment` in constant time, before reading further. Then, if a header was pinned for this link, require byte equality (`header-mismatch`).
2. Open manifest record 0, learn `m`, open records `1 .. m-1`, check the padding, decode and validate the manifest.
3. Open data records `0 .. n-1` in order, then the trailer; check its record count and root.
4. Treat end of input before the trailer as `truncated` and any byte after it as `trailing-data`.
5. **Output is provisional until the trailer verifies.** A receiver may stream plaintext to its sink as records authenticate, but the sink MUST NOT expose the result under its final name until the trailer has verified, and MUST discard it on any failure: file writers commit on close and abort on error, so a receiver errors its output, never closes it, when anything fails.

Error reasons, in the order checks happen: `invalid-header`, `unsupported-version`, `invalid-record-size`, `key-commitment-mismatch`, `header-mismatch`, `authentication-failed`, `invalid-manifest`, `size-mismatch`, `truncated`, `trailing-data`, `record-count-mismatch`, `root-hash-mismatch`. Implementations SHOULD report these names; the negative vectors use them.

## What observers learn

A relay, store or network observer without the secret learns:

- the exact `totalSize` (from the stream length and the last record's length) and the record size exponent;
- the manifest's size bucket `m` (a power of two, in 4 KiB records), which bounds the number and length of file names;
- the salt and key commitment, which identify one parcel across every path and store that carries it;
- timing and throughput, and the number of parcels in a room.

It does not learn file names, file count beyond the bucket, file boundaries, media types or content. This is acceptable for live transfers. Stored mode (phase 2) may need size padding, which would be a new version.

## Transport framing (not part of the parcel)

Records are the unit of encryption and resume, not of transport. `libraries/transport` splits records into frames that fit the path and may pack several records into one frame. Resume asks for "data records from index i".

## Test vectors and tests

- `libraries/parcel/test/vectors/vectors.json`: a fixed secret and salt; the room token and its hash, every derived key, and for each case the canonical manifest JSON, the header, every manifest record, every data record, the root hash and the trailer. Cases cover 0 bytes, 1 byte, one record minus one, exactly one record, one record plus one, three records with a short tail, several files with non-ASCII names and an empty file, the largest record size, and a manifest of more than one record.
- `libraries/parcel/test/vectors/rejections.json`: manifests and whole parcels every receiver must reject, each with its expected reason.
- `verify.py` reimplements this document alone (Python, pyca/cryptography over OpenSSL) and must reproduce every positive vector byte and reject every negative one with the same reason; CI runs it.
- Property tests: round trip for arbitrary sizes, record exponents and chunking; rejection of any single-bit flip, truncation at any byte, trailing data, reordered or duplicated records, a record spliced from another parcel, the wrong secret, and a dishonest trailer.
- Merkle code is checked against the RFC 6962 roots published in transparency-dev/merkle (`testonly/constants.go`).

## Open questions for the second review

- The synthetic prefix is 7 bytes because the counter takes 5 of the 12 nonce bytes. Is `2^-56` per pair of differing plaintexts at one counter enough, given that only resumes after an edit create such pairs?
- The trailer's record count duplicates what `totalSize` implies; it stays as a cheap cross-check. Should phase 2 define a public parcel digest over the header, manifest records and root (review note N4)?
- Unicode 15.1 is fixed for the name profile's categories and case folding. New characters in later versions stay allowed unless they fall in a listed category at 15.1, so receivers on newer Unicode data accept the same names.
