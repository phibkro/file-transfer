# 0015 Two parcel kinds: streaming and release on completion

Status: proposed (2026-10-28), not scheduled. Parcel v1 is frozen (ADR 0011) and stays the streaming kind; release on completion would be a second kind specified as parcel version 2, an alternative alongside v1 rather than its successor.

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
5. **Two kinds, chosen per parcel by its access policy.** A **streaming parcel** (v1) makes plaintext available as it arrives, so audio and video can play while downloading. A **release-on-completion parcel** (v2) keeps everything unreadable until the end. Both write ciphertext to disk while the sender sends, so release on completion costs only the second decryption pass and the loss of partial preview, not transfer time.
6. **Secure by default, streaming when it earns its place.** The sender's client proposes the kind from the manifest it is sealing: release on completion by default, streaming offered when the content is media that benefits from playing early (audio and video media types). The sender can override either way, and an account's or network's policy can forbid streaming. The choice is made on the sender's device, where the media types are already in plaintext.
7. **Mixed sends split into parcels.** A room already carries a sequence of contracts (ADR 0012), so a send of a video and some documents can be two parcels with different kinds, each accepted separately.
8. **The kind is visible to relays and stores.** A key-release step at the end of a transfer marks it as release on completion, so an observer can guess that streaming parcels are more likely media. That is a small metadata leak on top of the sizes and timing they already see (ADR 0012, security posture), accepted for now and noted for the observer section of the v2 specification.

## Consequences

- Plaintext appears only after the last record: no partial preview, and a second decryption pass over the whole parcel (about 21 s per 10 GB at the desktop sealing rate in ADR 0012; phones unmeasured). Bytes still flow while the sender sends (design R7); only readability waits.
- The window this protects is the transfer itself. Once a recipient holds every record and the content secret, revocation cannot take the contents back (ADR 0014, lazy revocation), and a recipient can always copy what it can read.
- Needs parcel version 2 with its own test vectors, property tests and review, like v1. Receivers support both kinds; the header's version byte tells them apart.
