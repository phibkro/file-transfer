# Parcel v1 (draft)

A parcel is the encrypted, authenticated container every transfer moves: what a sender seals and recipients open, carried unchanged over direct, relayed and stored paths. Terms are defined in `glossary.md`.

Status: implemented and tested; revised after the first review (docs/decisions/0011) and for contract before content (docs/decisions/0012); draft until the review's second pass. It freezes after that; after that, changes need a new version number, never an edit. Implemented in `libraries/parcel` (MIT).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

Design references: the age STREAM construction (counter nonce, final flag), synthetic initialisation vectors (Rogaway and Shrimpton, "Deterministic authenticated-encryption", 2006), RFC 5869 HKDF, RFC 6962 Merkle trees, RFC 8259 JSON, RFC 6838 media types, Microsoft's file naming rules. Rationale is in `research.md` and docs/decisions/0011 and 0012.

## Goals

- Stream encryption and decryption with constant memory per record, using Web Crypto AES-256-GCM, HMAC-SHA-256 and SHA-256 in the browser.
- **Contract before content:** the recipient learns everything the parcel promises (files, sizes, piece count, and a root committing to every sealed piece) before any content, and checks every piece against that promise as it arrives.
- Detect truncation, reordering, record swapping, header tampering, wrong keys, and a sender whose source changed after the contract.
- Key commitment, so one ciphertext cannot decrypt validly under two keys ("invisible salamanders").
- No nonce reuse even when a sender reseals a record whose plaintext changed: nonces are synthetic.
- One accept set: every conforming receiver accepts and rejects exactly the same bytes, checked by shared positive and negative test vectors.
- The same bytes work for live, relayed and (phase 2) stored transfers; stores and seeds verify pieces against the root without keys.

## Notation

- `||` is concatenation. `u8(x)`, `u32(x)`, `u40(x)`, `u64(x)` are unsigned big-endian integers of 1, 4, 5 and 8 bytes.
- `ascii("...")` is the ASCII bytes of a string, without a terminator.
- `HMAC(key, message)` is HMAC-SHA-256 (RFC 2104) with a 32-byte output; `H(x)` is SHA-256.
- `first(n, bytes)` is the first `n` bytes.

## Secrets and link

- The sender generates a 32-byte random **link secret** from a cryptographically secure generator.
- Link: `https://<host>/r/<roomIdentifier>#<fragment>`, where `fragment` is the link secret in base64url (RFC 4648 section 5) without padding: exactly 43 characters from `A-Z a-z 0-9 - _`. Receivers MUST reject any other length or alphabet, and any fragment that does not re-encode to itself (non-zero trailing bits). The fragment never reaches a server.
- A room carries a sequence of parcels (contracts), numbered `0, 1, 2, ...` by a `u32` **sequence number**. Parcel `s` seals under its own **parcel secret** derived from the link secret and `s` (below).
- **A parcel secret seals exactly one parcel.** A sender MUST NOT seal two different parcels (two salts, or two manifests) under one sequence number; a changed contract takes the next sequence number. A recipient that has accepted a header for a sequence number MUST reject a different header for it, including on resume.

## Key derivation

Every key comes from HKDF-SHA-256 (RFC 5869) with the extraction salt `ascii("parcel/v1")`:

```
extract(ikm)        = HMAC(ascii("parcel/v1"), ikm)
expand(ikm, info)   = HMAC(extract(ikm), info || u8(1))       (RFC 5869 T(1); 32 bytes)

roomToken           = expand(linkSecret, ascii("parcel/v1/room-token"))
parcelSecret        = expand(linkSecret, ascii("parcel/v1/parcel-secret") || u32(sequence))
```

| Output                 | `expand(parcelSecret, info)` with info                | Use                                                                                         |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `contentKey`           | `ascii("parcel/v1/content-key") \|\| salt`            | AES-256-GCM key of the data stream                                                          |
| `contentSyntheticKey`  | `ascii("parcel/v1/content-synthetic-key") \|\| salt`  | HMAC key for the data stream's synthetic nonces                                             |
| `manifestKey`          | `ascii("parcel/v1/manifest-key") \|\| salt`           | AES-256-GCM key of the manifest stream                                                      |
| `manifestSyntheticKey` | `ascii("parcel/v1/manifest-synthetic-key") \|\| salt` | HMAC key for the manifest stream's synthetic nonces                                         |
| `keyCommitment`        | `ascii("parcel/v1/key-commitment") \|\| salt`         | Stored in the header; recomputed and compared in constant time before anything is decrypted |

`roomToken` proves link possession to signaling and relays; servers store only `H(roomToken)`. `salt` is the header's 16 random bytes; with one parcel per parcel secret it is defence in depth against a sender that reuses a sequence number. No info string is a prefix of another and the variable parts have fixed lengths, so every pair of inputs to `expand` differs. Each output is used as raw key bytes or compared directly. In Web Crypto, `deriveBits` or `deriveKey` with `{ name: "HKDF", hash: "SHA-256", salt: ascii("parcel/v1"), info }` over the input keying material and a 256-bit length computes exactly `expand(ikm, info)`.

## Stream layout

```
header | manifest record 0 .. m-1 | label page 0 | data records of page 0 | label page 1 | data records of page 1 | ...
```

The **contract** is the header and the manifest records: everything the parcel promises, sealed, before any content. Then each **label page** precedes the data records it covers. Every length is known before the bytes arrive, so a receiver cuts the stream without delimiters:

- the header is 58 bytes;
- each manifest record is `4096 + 23` bytes; manifest record 0 tells `m`;
- the contract gives `n` data records of known lengths; label page `j` covers records `1024 j` to `min(n, 1024 (j + 1)) - 1` and its length follows from `n` and `j`;
- the parcel ends with data record `n - 1`. Nothing may follow it.

### Header (58 bytes, plaintext)

| Offset | Size | Field              | Value                                                                     |
| ------ | ---- | ------------------ | ------------------------------------------------------------------------- |
| 0      | 4    | magic              | `0x45 0x32 0x45 0x01`                                                     |
| 4      | 1    | version            | `1`                                                                       |
| 5      | 1    | recordSizeExponent | data record plaintext size is `2^n` bytes; default `16`; allowed 12 to 22 |
| 6      | 4    | sequence           | `u32`, the parcel's sequence number in its room                           |
| 10     | 16   | salt               | random per parcel                                                         |
| 26     | 32   | keyCommitment      | derived as above                                                          |

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

Why synthetic: the nonce depends on the plaintext, so resealing record `i` with the same plaintext gives the same bytes (the labelling pass and resume reproduce them exactly) and resealing it with different plaintext gives a different nonce (no AES-GCM nonce reuse). Two different plaintexts at one counter collide on the 7 synthetic bytes with probability about `2^-56` per pair, and nobody without `syntheticKey` can search for a collision. Records at different counters never share a nonce. The final flag is in the associated data, so a truncated stream cannot pass a non-final record off as final.

### Labels and the root

A data record's **label** is its RFC 6962 leaf hash, `H(0x00 || record)`, over all `|P| + 23` bytes as sent. The **root** is the RFC 6962 Merkle tree hash over the labels of records `0 .. n-1`: an interior node is `H(0x01 || left || right)` and a range splits at the largest power of two below its size.

The sender computes every label before sending anything (the **labelling pass**): it seals each record once, keeps its 32-byte label and discards the record. Sealing is deterministic, so the sending pass reproduces the same records; a sender whose resealed record does not match its label knows its source changed and MUST stop (`source-changed`) rather than send it.

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

**Manifest stream plaintext (the sealed contract).** Let `J` be the canonical JSON and `L` its length, `L <= 2^24 - 44`. The manifest stream's plaintext is

```
u64(n) || root || u32(L) || J || zero bytes
```

padded to `m * 4096` bytes, where `m` is the smallest power of two with `m * 4096 >= 44 + L` (so `m <= 4096`). It is cut into `m` records of 4096 bytes at counters `0 .. m-1`, all with flag `0x00`: record 0 fixes `m`, so the manifest stream needs no final flag, and a receiver opens record 0 before it could know which record is last. A receiver reads record 0, learns `L` and so `m`, reads exactly `m` manifest records, and rejects (`invalid-manifest`) unless every padding byte is zero. It rejects (`record-count-mismatch`) unless `n = max(1, ceil(totalSize / R))` with `R = 2^recordSizeExponent`.

The **contract digest** is `H(header || manifest record 0 || ... || manifest record m-1)`, over the bytes as sent. A recipient's acceptance names it (the acceptance message belongs to the room protocol, not to the parcel).

### Label pages

Label page `j` (`0 <= j < k`, `k = ceil(n / 1024)`) carries the labels of the records it covers and a proof that they belong to the root. It is plaintext: labels are hashes of public ciphertext, and the proof makes them as trustworthy as the sealed root.

```
page_j = label(1024 j) || ... || label(min(n, 1024 (j + 1)) - 1) || sibling_1 || ... || sibling_d
```

Let `pageRoot_j` be the RFC 6962 tree hash over page `j`'s labels (labels are already leaf hashes, so only interior nodes are computed). Because 1024 is a power of two, every page is a node of the tree over all labels, and the root is the tree hash over `pageRoot_0 .. pageRoot_{k-1}` with the same splitting rule (a single node is itself). The siblings are the hashes of page `j`'s audit path in that tree over page roots, nearest first:

```
siblings(lo, hi, j):                      (pages lo .. hi-1; starts as siblings(0, k, j))
  if hi - lo = 1: []
  s = largest power of two below hi - lo
  if j < lo + s: siblings(lo, lo + s, j) || [right: tree(lo + s .. hi)]
  else:          siblings(lo + s, hi, j) || [left: tree(lo .. lo + s)]
```

The receiver derives `d` and each sibling's side from `n` and `j`, computes `pageRoot_j`, folds the siblings (`H(0x01 || node || sibling)` for a right sibling, `H(0x01 || sibling || node)` for a left one) and rejects the page (`label-page-mismatch`) unless the result equals the contract's root. Page `j` is `32 * (labels + d)` bytes.

### Data records

Counters `0 .. n-1`; every record holds exactly `R` bytes of plaintext except the last (flag `0x01`), which holds `totalSize - (n - 1) * R` bytes: between 1 and `R`, or 0 only when `totalSize` is 0 (then `n = 1`). Data records carry the files' bytes concatenated in manifest order; boundaries come from the sizes. A receiver checks each record's label before opening it.

## Limits

| Quantity             | Limit                                                  |
| -------------------- | ------------------------------------------------------ |
| `totalSize`          | `< 2^40` bytes (1 TiB)                                 |
| data records `n`     | `<= 2^28` (implied)                                    |
| any record counter   | `< 2^40`                                               |
| canonical JSON `L`   | `<= 2^24 - 44` bytes                                   |
| manifest records `m` | `<= 4096`                                              |
| labels per page      | 1024 (a page is 32 KiB plus at most 18 sibling hashes) |

The size limit keeps the AES-GCM confidentiality advantage per key near `2^-57` (draft-irtf-cfrg-aead-limits); product limits are lower (docs/design.md, R5). A sender keeps 32 bytes of labels per record between the passes: 4.9 MB for 10 GB and 24 MB for 50 GB at 64 KiB records.

## Sender rules

- One parcel per parcel secret: a fresh 16-byte random salt, and a new sequence number for any changed contract.
- Seal and label every data record before sending the contract; reseal while sending and stop with `source-changed` at the first record whose label differs.
- Send no data record before the recipient has accepted the contract digest (room protocol).
- Resume: send the identical contract again (it is deterministic given the link secret, sequence number, salt, manifest and labels), then the label page that covers record `i` and the records from `i`. Both sides can check "records `0 .. i-1` of contract X" against the labels.

## Receiver rules

1. Read the header; check magic, version and `recordSizeExponent`; derive the keys and compare `keyCommitment` in constant time, before reading further. Then, if a header was pinned for this sequence number, require byte equality (`header-mismatch`).
2. Open manifest record 0, learn `m`, open records `1 .. m-1`, check the padding, decode and validate the manifest, check `n`. The contract is complete; the room protocol may now accept its digest.
3. For each page: verify the page against the root, then for each of its records check the label, open the record and release its plaintext provisionally.
4. Treat end of input before record `n - 1` as `truncated` and any byte after it as `trailing-data`.
5. **Output is provisional until the last record verifies.** A receiver may stream plaintext to its sink as records verify, but the sink MUST NOT expose the result under its final name until the whole parcel has verified, and MUST discard it on any failure: file writers commit on close and abort on error, so a receiver errors its output, never closes it, when anything fails. A record whose label differs from the contract is a **breach**: the receiver stops at that record and reports its index.

Error reasons, in the order checks happen: `invalid-header`, `unsupported-version`, `invalid-record-size`, `key-commitment-mismatch`, `header-mismatch`, `authentication-failed`, `invalid-manifest`, `record-count-mismatch`, `label-page-mismatch`, `label-mismatch`, `size-mismatch`, `truncated`, `trailing-data`; and for senders, `source-changed`. Implementations SHOULD report these names; the negative vectors use them.

## What observers learn

A relay, store or network observer without the secret learns:

- the exact `totalSize` (from the stream length and the last record's length) and the record size exponent;
- the manifest's size bucket `m` (a power of two, in 4 KiB records), which bounds the number and length of file names;
- the labels and their pages (hashes of ciphertext it sees anyway, but before the records arrive);
- the sequence number, salt and key commitment, which identify one parcel across every path and store that carries it;
- timing and throughput, and the number of parcels in a room.

It does not learn file names, file count beyond the bucket, file boundaries, media types or content. This is acceptable for live transfers. Stored mode (phase 2) may need size padding, which would be a new version.

## Transport framing (not part of the parcel)

Records and pages are the units of encryption, verification and resume, not of transport. `libraries/transport` splits them into frames that fit the path and may pack several into one frame. Resume asks for "data records from index i of contract X".

## Test vectors and tests

- `libraries/parcel/test/vectors/vectors.json`: a fixed link secret and salt; the room token and its hash, each case's parcel secret and derived keys, and per case the canonical manifest JSON, the header, every manifest record, the labels, the root, the contract digest, every label page, and every data record (or only its label, for the case with more than one page). Cases cover 0 bytes, 1 byte, one record minus one, exactly one record, one record plus one, three records with a short tail, several files with non-ASCII names and an empty file, the largest record size, a manifest of more than one record, a sequence number other than 0, and more than one label page.
- `libraries/parcel/test/vectors/rejections.json`: manifests and whole parcels every receiver must reject, each with its expected reason.
- `verify.py` reimplements this document alone (Python, pyca/cryptography over OpenSSL) and must reproduce every positive vector byte and reject every negative one with the same reason; CI runs it.
- Property tests: round trip for arbitrary sizes, record exponents and chunking; page proofs against the direct RFC 6962 definition; rejection of any single-bit flip, truncation at any byte, trailing data, reordered or duplicated records, a record spliced from another parcel, the wrong secret, a tampered label page, and a breach (a record that differs from its label) at the first changed record.
- Merkle code is checked against the RFC 6962 roots published in transparency-dev/merkle (`testonly/constants.go`).

## Open questions for the second review

- The synthetic prefix is 7 bytes because the counter takes 5 of the 12 nonce bytes. Is `2^-56` per pair of differing plaintexts at one counter enough, given that only a sender whose source changed creates such pairs, and the labelling pass now stops it?
- Label pages are plaintext and authenticated only through the root. Is there any reason to seal them?
- Unicode 15.1 is fixed for the name profile's categories and case folding. New characters in later versions stay allowed unless they fall in a listed category at 15.1, so receivers on newer Unicode data accept the same names; NFC of characters assigned after 15.1 could still differ between runtimes.
