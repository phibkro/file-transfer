# 0015 Content key released on completion (parcel version 2 candidate)

Status: proposed (2026-10-28), not scheduled. Parcel v1 is frozen (ADR 0011); this would be parcel version 2.

## Context

The product owner's requirement: if access changes mid-transfer (the sender cancels, a grant is revoked, a claim expires), the pieces a recipient already holds must not be readable; a parcel's contents should be readable only once all of it has arrived.

Parcel v1 cannot do this. `contentKey` and `manifestKey` both derive from the parcel secret (`docs/parcel.md`, Keys), and a recipient needs the manifest key to read the contract before accepting it (ADR 0012). So every recipient who accepts can decrypt each data record as it arrives, which is what lets files stream to disk while sending continues.

Two known ways to make partial ciphertext useless:

- An all-or-nothing transform (Rivest, "All-or-Nothing Encryption and the Package Transform", FSE 1997): the message is transformed so that no block can be recovered without all of them. It needs no extra round trip but costs a full transform pass on each side and changes how records are formed.
- Withholding the key: send ciphertext under a key the recipient does not yet have, and release that key only when the recipient holds everything.

Withholding fits this design, because labels are hashes of sealed records (ADR 0012): a recipient can verify every record against the contract root without any key.

## Proposal

1. **Two secrets per parcel.** Parcel v2 derives the manifest keys from the parcel secret as in v1, but seals data records under a separate, random **content secret**. The content secret is not derivable from anything the recipient receives before completion.
2. **Contract, then ciphertext, then key.** The recipient opens and accepts the contract as today, receives every data record and checks each against its label (no key needed), then reports completion. Only then does the sender, or a store holding the wrapped content secret, release it, sealed under the parcel secret. The recipient decrypts in a second pass, in place.
3. **Revocation before release leaves nothing readable.** If access changes before release, the sender or store simply never releases the content secret; the recipient holds ciphertext and labels only. With several recipients, release is per recipient.
4. **Completion becomes an authorisation, so it must be authenticated.** v1 notes that acceptance and completion messages are computable from public bytes; once completion releases a key, the room protocol must MAC it under a key derived from the parcel secret (`docs/parcel.md`, Observer section). A recipient who claims completion early gains only the ability to decrypt the records it already holds.
5. **A per-transfer policy, not a silent default.** Streaming (v1 behaviour: plaintext as it arrives, video can play while downloading) and release on completion (nothing readable until the end) both have uses. The access policy names which one a transfer uses; stored assets and multi-recipient grants would default to release on completion.

## Consequences

- Plaintext appears only after the last record: no partial preview, and a second decryption pass over the whole parcel (about 21 s per 10 GB at the desktop sealing rate in ADR 0012; phones unmeasured). Bytes still flow while the sender sends (design R7); only readability waits.
- The window this protects is the transfer itself. Once a recipient holds every record and the content secret, revocation cannot take the contents back (ADR 0014, lazy revocation), and a recipient can always copy what it can read.
- Needs parcel version 2 with its own test vectors, property tests and review, like v1. v1 stays the streaming format.
