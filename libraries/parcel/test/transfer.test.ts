import fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import {
  concatBytes,
  createManifest,
  createDecryptionStream,
  createParcelSealer,
  createParcelSender,
  headerLength,
  labelRecords,
  openHeader,
  recordReaderFromBytes,
} from "../src/index.ts"
import { collect, decryptAll, encryptAll, fromChunks, layoutOf, outcome, receivePartially, singleFileManifest } from "./support.ts"

const secretArbitrary = fc.uint8Array({ minLength: 32, maxLength: 32 })
const exponent = 12
const size = 2 ** exponent

/** Sizes around the record boundaries, plus random ones, up to five records. */
const lengthArbitrary = fc.oneof(fc.constantFrom(0, 1, size - 1, size, size + 1, 3 * size - 7), fc.integer({ min: 0, max: 5 * size }))

const bytesOf = (length: number, seed: number) => Uint8Array.from({ length }, (_, index) => (index * 31 + seed) & 0xff)

describe("round trip", () => {
  it("receives what was sent, for any size, record exponent and chunking", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArbitrary,
        lengthArbitrary,
        fc.integer({ min: 12, max: 14 }),
        fc.integer({ min: 1, max: 9000 }),
        async (secret, length, recordSizeExponent, decryptChunk) => {
          const data = bytesOf(length, length)
          const parcel = await encryptAll({ secret, data, recordSizeExponent })
          expect(parcel.length).toBe(layoutOf(singleFileManifest(length), recordSizeExponent).end)
          const { manifest, plaintext } = await decryptAll(secret, parcel, decryptChunk)
          expect(manifest.totalSize).toBe(length)
          expect(Buffer.from(plaintext).equals(Buffer.from(data))).toBe(true)
        },
      ),
      { numRuns: 50 },
    )
  })

  it("carries several files, non-ASCII names and a manifest longer than one record", async () => {
    const files = [
      { name: "photos/café.jpg", size: 5000, mediaType: "image/jpeg" },
      { name: "empty.txt", size: 0, mediaType: "text/plain" },
      ...Array.from({ length: 150 }, (_, index) => ({ name: `日本語/ファイル-${index}.md`, size: 1, mediaType: "" })),
    ]

    const manifest = createManifest(files)
    expect(layoutOf(manifest, exponent).manifestRecordStarts.length).toBeGreaterThan(1)
    const secret = new Uint8Array(32).fill(9)
    const data = bytesOf(manifest.totalSize, 3)
    const result = await decryptAll(secret, await encryptAll({ secret, data, recordSizeExponent: exponent, manifest }))
    expect(result.manifest).toEqual(manifest)
    expect(result.plaintext.length).toBe(manifest.totalSize)
  })

  it("fresh salts make two parcels differ; the same salt and sequence reseal identical bytes; another sequence seals under another secret", async () => {
    const secret = new Uint8Array(32).fill(1)
    const data = bytesOf(100, 0)
    const first = await encryptAll({ secret, data, recordSizeExponent: exponent })
    const second = await encryptAll({ secret, data, recordSizeExponent: exponent })
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
    const salt = first.slice(10, 26)
    expect(Buffer.from(await encryptAll({ secret, data, recordSizeExponent: exponent, salt })).equals(Buffer.from(first))).toBe(true)
    const third = await encryptAll({ secret, data, recordSizeExponent: exponent, salt, sequence: 3 })
    expect(Buffer.from(third.subarray(26, 58)).equals(Buffer.from(first.subarray(26, 58)))).toBe(false)
    expect((await decryptAll(secret, third)).plaintext.length).toBe(100)
  })

  it("spans several label pages, and a page that does not belong to the root is rejected", async () => {
    const secret = new Uint8Array(32).fill(11)
    const length = 1029 * size + 17
    const data = bytesOf(length, 7)
    const parcel = await encryptAll({ secret, data, recordSizeExponent: exponent })
    const layout = layoutOf(singleFileManifest(length), exponent)
    expect(layout.pages.length).toBe(2)
    expect(parcel.length).toBe(layout.end)
    expect(Buffer.from((await decryptAll(secret, parcel, 65_536)).plaintext).equals(Buffer.from(data))).toBe(true)

    for (const [page, position] of [
      [0, 0],
      [1, 0],
      [1, -1],
    ] as const) {
      const range = layout.pages[page]

      if (range === undefined) {
        throw new Error("layout")
      }

      const tampered = parcel.slice()
      const at = position < 0 ? range.end + position : range.start + position
      tampered[at] = (tampered[at] ?? 0) ^ 1
      expect(await outcome(decryptAll(secret, tampered, 65_536))).toBe("label-page-mismatch")
    }
  })
})

describe("sending", () => {
  it("fails with size-mismatch when the source is shorter than the manifest declares", async () => {
    const secret = new Uint8Array(32).fill(1)
    expect(await outcome(encryptAll({ secret, data: bytesOf(10, 0), recordSizeExponent: exponent, manifest: singleFileManifest(11) }))).toBe("size-mismatch")
  })

  it("stops with source-changed at the first record that no longer matches its label", async () => {
    const secret = new Uint8Array(32).fill(12)
    const data = bytesOf(3 * size, 2)
    const changed = data.slice()
    changed[size + 9] = (changed[size + 9] ?? 0) ^ 0xff
    expect(await outcome(encryptAll({ secret, data, recordSizeExponent: exponent, readForSending: recordReaderFromBytes(changed, size) }))).toBe(
      "source-changed",
    )
  })
})

describe("a breach is caught at the first changed record", () => {
  it("a sender that keeps sending after its source changed: earlier records are released, the changed one is not", async () => {
    const secret = new Uint8Array(32).fill(13)
    const data = bytesOf(4 * size, 4)
    const changed = data.slice()
    changed[2 * size + 1] = (changed[2 * size + 1] ?? 0) ^ 0xff
    const sealer = await createParcelSealer({ linkSecret: secret, manifest: singleFileManifest(data.length), recordSizeExponent: exponent })
    const contract = await sealer.sealContract(await labelRecords(sealer, recordReaderFromBytes(data, size)))
    const records: Uint8Array[] = []

    for (let index = 0; index < sealer.recordCount; index++) {
      records.push(await sealer.sealData(index, changed.subarray(index * size, (index + 1) * size)))
    }

    const parcel = concatBytes(contract.header.bytes, ...contract.manifestRecords, await contract.labelPage(0), ...records)
    const { released, outcome: ending } = await receivePartially(secret, parcel)
    expect(ending).toBe("label-mismatch")
    expect(released.length).toBe(2 * size)
    expect(Buffer.from(released).equals(Buffer.from(data.subarray(0, 2 * size)))).toBe(true)
  })
})

describe("tampering is rejected", () => {
  const fixture = async (secret: Uint8Array, length: number) => await encryptAll({ secret, data: bytesOf(length, 5), recordSizeExponent: exponent })

  it("any single bit flip anywhere", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArbitrary,
        fc.integer({ min: 0, max: 3 * size }),
        fc.nat(),
        fc.integer({ min: 0, max: 7 }),
        async (secret, length, position, bit) => {
          const parcel = (await fixture(secret, length)).slice()
          const index = position % parcel.length
          parcel[index] = (parcel[index] ?? 0) ^ (1 << bit)
          expect(await outcome(decryptAll(secret, parcel))).not.toBe("accepted")
        },
      ),
      { numRuns: 80 },
    )
  })

  it("truncation at any byte, with 'truncated' at every unit boundary", async () => {
    const secret = new Uint8Array(32).fill(2)
    const parcel = await fixture(secret, 2 * size + 100)
    await fc.assert(
      fc.asyncProperty(fc.nat(), async (cut) => {
        expect(await outcome(decryptAll(secret, parcel.subarray(0, cut % parcel.length)))).not.toBe("accepted")
      }),
      { numRuns: 60 },
    )
    const layout = layoutOf(singleFileManifest(2 * size + 100), exponent)

    const boundaries = [
      headerLength,
      ...layout.pages.map((page) => page.start),
      ...layout.pages.map((page) => page.end),
      ...layout.data.slice(0, -1).map((record) => record.end),
    ]

    for (const boundary of boundaries) {
      expect(await outcome(decryptAll(secret, parcel.subarray(0, boundary)))).toBe("truncated")
    }
  })

  it("data after the last record", async () => {
    const secret = new Uint8Array(32).fill(3)
    expect(await outcome(decryptAll(secret, concatBytes(await fixture(secret, 10), new Uint8Array([0]))))).toBe("trailing-data")
  })

  it("reordered and duplicated records differ from their labels", async () => {
    const secret = new Uint8Array(32).fill(4)
    const parcel = await fixture(secret, 3 * size)
    const [first, second] = layoutOf(singleFileManifest(3 * size), exponent).data

    if (first === undefined || second === undefined) {
      throw new Error("fixture needs two records")
    }

    const swapped = parcel.slice()
    swapped.set(parcel.subarray(second.start, second.end), first.start)
    swapped.set(parcel.subarray(first.start, first.end), second.start)
    expect(await outcome(decryptAll(secret, swapped))).toBe("label-mismatch")
    const duplicated = parcel.slice()
    duplicated.set(parcel.subarray(first.start, first.end), second.start)
    expect(await outcome(decryptAll(secret, duplicated))).toBe("label-mismatch")
  })

  it("a record spliced in from another parcel under the same secret", async () => {
    const secret = new Uint8Array(32).fill(6)
    const first = await fixture(secret, 2 * size)
    const second = await fixture(secret, 2 * size)
    const [record] = layoutOf(singleFileManifest(2 * size), exponent).data

    if (record === undefined) {
      throw new Error("fixture layout")
    }

    const spliced = first.slice()
    spliced.set(second.subarray(record.start, record.end), record.start)
    expect(await outcome(decryptAll(secret, spliced))).toBe("label-mismatch")
  })

  it("the wrong secret, reported from the header alone before anything else is read", async () => {
    await fc.assert(
      fc.asyncProperty(secretArbitrary, secretArbitrary, async (secret, other) => {
        fc.pre(Buffer.from(secret).compare(Buffer.from(other)) !== 0)
        const parcel = await fixture(secret, 100)
        expect(await outcome(decryptAll(other, parcel))).toBe("key-commitment-mismatch")
        expect(await outcome(decryptAll(other, parcel.subarray(0, headerLength)))).toBe("key-commitment-mismatch")
      }),
      { numRuns: 20 },
    )
  })

  it("a different parcel for a sequence number that already accepted a contract (one parcel per parcel secret)", async () => {
    const secret = new Uint8Array(32).fill(7)
    const accepted = await fixture(secret, 100)
    const substitute = await fixture(secret, 100)
    const expectedDigest = (await sendWithContract(secret, bytesOf(100, 5))).contract.digest
    expect(await outcome(decryptAll(secret, substitute, 777, { expectedDigest }))).toBe("contract-mismatch")
    const { contract } = await sendWithContract(secret, bytesOf(100, 5), accepted.slice(10, 26))
    expect(await outcome(decryptAll(secret, accepted, 777, { expectedDigest: contract.digest }))).toBe("accepted")
  })
})

/** Sends `data` as one file at sequence 0, returning the contract and the parcel bytes. */
const sendWithContract = async (secret: Uint8Array, data: Uint8Array, salt?: Uint8Array, expectedDigest?: Uint8Array) => {
  const sender = await createParcelSender({
    linkSecret: secret,
    manifest: singleFileManifest(data.length),
    recordSizeExponent: exponent,
    readRecord: recordReaderFromBytes(data, size),
    ...(salt === undefined ? {} : { salt }),
    ...(expectedDigest === undefined ? {} : { expectedDigest }),
  })

  return { contract: sender.contract, parcel: await collect(sender.stream) }
}

describe("a sender that relabels a changed file on resume (second review, S1)", () => {
  const secret = new Uint8Array(32).fill(21)
  const salt = new Uint8Array(16).fill(5)
  const original = bytesOf(3 * size, 8)
  const changed = original.slice()
  changed[2 * size + 3] = (changed[2 * size + 3] ?? 0) ^ 0xff

  it("produces a different contract under a byte-identical header, which a receiver pinning the digest rejects", async () => {
    const first = await sendWithContract(secret, original, salt)
    const second = await sendWithContract(secret, changed, salt)
    expect(Buffer.from(second.parcel.subarray(0, headerLength)).equals(Buffer.from(first.parcel.subarray(0, headerLength)))).toBe(true)
    expect(await outcome(decryptAll(secret, second.parcel))).toBe("accepted")
    expect(await outcome(decryptAll(secret, second.parcel, 777, { expectedDigest: first.contract.digest }))).toBe("contract-mismatch")
    expect(await outcome(decryptAll(secret, first.parcel, 777, { expectedDigest: first.contract.digest }))).toBe("accepted")
  })

  it("is caught by the sender itself when it compares the new digest with the stored one", async () => {
    const stored = (await sendWithContract(secret, original, salt)).contract.digest
    expect(await outcome(sendWithContract(secret, changed, salt, stored))).toBe("source-changed")
    expect(await outcome(sendWithContract(secret, original, salt, stored))).toBe("accepted")
  })

  it("the receiver's digest is the sender's", async () => {
    const { contract, parcel } = await sendWithContract(secret, original, salt)
    const { stream, contract: received } = createDecryptionStream(secret)
    await collect(fromChunks([parcel]).pipeThrough(stream))
    expect(Buffer.from((await received).digest).equals(Buffer.from(contract.digest))).toBe(true)
  })
})

describe("a record that arrives before its label page (receiver rule 6)", () => {
  it("is refused with label-page-missing, opens once the page verifies, and is refused again after the page is released", async () => {
    const secret = new Uint8Array(32).fill(22)
    const data = bytesOf(2 * size, 9)
    const sealer = await createParcelSealer({ linkSecret: secret, manifest: singleFileManifest(data.length), recordSizeExponent: exponent })
    const contract = await sealer.sealContract(await labelRecords(sealer, recordReaderFromBytes(data, size)))
    const records = [await sealer.sealData(0, data.subarray(0, size)), await sealer.sealData(1, data.subarray(size))]
    const opener = await openHeader(secret, contract.header.bytes)
    const plaintexts = await Promise.all(contract.manifestRecords.map(async (record, counter) => await opener.openManifestRecord(counter, record)))
    const receiver = await opener.acceptContract(plaintexts, contract.manifestRecords)
    const [first, second] = records

    if (first === undefined || second === undefined) {
      throw new Error("fixture")
    }

    expect(await outcome(receiver.openData(0, first))).toBe("label-page-missing")
    await receiver.verifyPage(0, await contract.labelPage(0))
    expect(Buffer.from(await receiver.openData(0, first)).equals(Buffer.from(data.subarray(0, size)))).toBe(true)
    receiver.releasePage(0)
    expect(await outcome(receiver.openData(1, second))).toBe("label-page-missing")
  })
})
