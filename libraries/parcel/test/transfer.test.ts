import fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import { concatBytes, createEncryptor, createManifest, headerLength, merkleRoot, recordOverhead, trailerRecordLength } from "../src/index.ts"
import { decryptAll, encryptAll, layoutOf, outcome, singleFileManifest } from "./support.ts"

const secretArbitrary = fc.uint8Array({ minLength: 32, maxLength: 32 })
const exponent = 12
const size = 2 ** exponent

/** Sizes around the record boundaries, plus random ones, up to five records. */
const lengthArbitrary = fc.oneof(fc.constantFrom(0, 1, size - 1, size, size + 1, 3 * size - 7), fc.integer({ min: 0, max: 5 * size }))

const bytesOf = (length: number, seed: number) => Uint8Array.from({ length }, (_, index) => (index * 31 + seed) & 0xff)

describe("round trip", () => {
  it("decrypts what it encrypts, for any size, record exponent and chunking", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArbitrary,
        lengthArbitrary,
        fc.integer({ min: 12, max: 14 }),
        fc.integer({ min: 1, max: 9000 }),
        fc.integer({ min: 1, max: 9000 }),
        async (secret, length, recordSizeExponent, encryptChunk, decryptChunk) => {
          const data = bytesOf(length, length)
          const parcel = await encryptAll({ secret, data, recordSizeExponent, chunkSize: encryptChunk })
          expect(parcel.length).toBe(layoutOf(singleFileManifest(length), recordSizeExponent).end)
          const { manifest, plaintext } = await decryptAll(secret, parcel, decryptChunk)
          expect(manifest.totalSize).toBe(length)
          expect(Buffer.from(plaintext).equals(Buffer.from(data))).toBe(true)
        },
      ),
      { numRuns: 60 },
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

  it("fresh salts make two parcels of the same input differ; the same salt reseals identical bytes", async () => {
    const secret = new Uint8Array(32).fill(1)
    const data = bytesOf(100, 0)
    const first = await encryptAll({ secret, data, recordSizeExponent: exponent })
    const second = await encryptAll({ secret, data, recordSizeExponent: exponent })
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
    const salt = first.slice(6, 22)
    expect(Buffer.from(await encryptAll({ secret, data, recordSizeExponent: exponent, salt })).equals(Buffer.from(first))).toBe(true)
  })
})

describe("encryption input", () => {
  it("rejects more or less plaintext than the manifest declares", async () => {
    const secret = new Uint8Array(32).fill(1)
    expect(await outcome(encryptAll({ secret, data: bytesOf(10, 0), recordSizeExponent: exponent, manifest: singleFileManifest(9) }))).toBe("size-mismatch")
    expect(await outcome(encryptAll({ secret, data: bytesOf(10, 0), recordSizeExponent: exponent, manifest: singleFileManifest(11) }))).toBe("size-mismatch")
  })
})

describe("tampering is rejected", () => {
  const fixture = (secret: Uint8Array, length: number) => encryptAll({ secret, data: bytesOf(length, 5), recordSizeExponent: exponent })

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
    for (const boundary of [headerLength, layout.dataStart, ...layout.data.map((record) => record.end)]) {
      expect(await outcome(decryptAll(secret, parcel.subarray(0, boundary)))).toBe("truncated")
    }
  })

  it("data after the trailer", async () => {
    const secret = new Uint8Array(32).fill(3)
    expect(await outcome(decryptAll(secret, concatBytes(await fixture(secret, 10), new Uint8Array([0]))))).toBe("trailing-data")
  })

  it("reordered and duplicated records", async () => {
    const secret = new Uint8Array(32).fill(4)
    const parcel = await fixture(secret, 3 * size)
    const [first, second] = layoutOf(singleFileManifest(3 * size), exponent).data
    if (first === undefined || second === undefined) throw new Error("fixture needs two records")
    const swapped = parcel.slice()
    swapped.set(parcel.subarray(second.start, second.end), first.start)
    swapped.set(parcel.subarray(first.start, first.end), second.start)
    expect(await outcome(decryptAll(secret, swapped))).toBe("authentication-failed")
    const duplicated = parcel.slice()
    duplicated.set(parcel.subarray(first.start, first.end), second.start)
    expect(await outcome(decryptAll(secret, duplicated))).toBe("authentication-failed")
  })

  it("a data record and the trailer swapped (same length, different streams)", async () => {
    const secret = new Uint8Array(32).fill(5)
    // A last record of 40 plaintext bytes has the trailer's length.
    const parcel = await fixture(secret, size + 40)
    const layout = layoutOf(singleFileManifest(size + 40), exponent)
    const last = layout.data.at(-1)
    if (last === undefined || last.end - last.start !== trailerRecordLength) throw new Error("fixture layout")
    const swapped = parcel.slice()
    swapped.set(parcel.subarray(layout.trailerStart), last.start)
    swapped.set(parcel.subarray(last.start, last.end), layout.trailerStart)
    expect(await outcome(decryptAll(secret, swapped))).toBe("authentication-failed")
  })

  it("a record spliced in from another parcel under the same secret", async () => {
    const secret = new Uint8Array(32).fill(6)
    const first = await fixture(secret, 2 * size)
    const second = await fixture(secret, 2 * size)
    const [record] = layoutOf(singleFileManifest(2 * size), exponent).data
    if (record === undefined) throw new Error("fixture layout")
    const spliced = first.slice()
    spliced.set(second.subarray(record.start, record.end), record.start)
    expect(await outcome(decryptAll(secret, spliced))).toBe("authentication-failed")
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

  it("a different parcel for a link that already accepted a header (one secret, one parcel)", async () => {
    const secret = new Uint8Array(32).fill(7)
    const accepted = await fixture(secret, 100)
    const substitute = await fixture(secret, 100)
    const expectedHeader = accepted.subarray(0, headerLength)
    expect(await outcome(decryptAll(secret, accepted, 777, { expectedHeader }))).toBe("accepted")
    expect(await outcome(decryptAll(secret, substitute, 777, { expectedHeader }))).toBe("header-mismatch")
  })
})

describe("a sender with the keys cannot lie in the trailer", () => {
  const assemble = async (trailer: (rootHash: Uint8Array, recordCount: number) => { recordCount: number; rootHash: Uint8Array }) => {
    const secret = new Uint8Array(32).fill(8)
    const data = bytesOf(2 * size + 9, 1)
    const encryptor = await createEncryptor({ secret, manifest: singleFileManifest(data.length), recordSizeExponent: exponent })
    const records: Array<Uint8Array> = []
    for (let index = 0; index < encryptor.recordCount; index++) {
      records.push(await encryptor.sealData(index, data.subarray(index * size, Math.min((index + 1) * size, data.length))))
    }
    const rootHash = await merkleRoot(records)
    const sealed = await encryptor.sealTrailer(trailer(rootHash, encryptor.recordCount))
    expect(records.every((record, index) => record.length === encryptor.dataRecordLength(index) && record.length >= recordOverhead)).toBe(true)
    return { secret, parcel: concatBytes(encryptor.header.bytes, ...(await encryptor.sealManifest()), ...records, sealed) }
  }

  it("accepts the honest trailer", async () => {
    const { secret, parcel } = await assemble((rootHash, recordCount) => ({ recordCount, rootHash }))
    expect(await outcome(decryptAll(secret, parcel))).toBe("accepted")
  })

  it("rejects a wrong root hash", async () => {
    const { secret, parcel } = await assemble((_, recordCount) => ({ recordCount, rootHash: new Uint8Array(32) }))
    expect(await outcome(decryptAll(secret, parcel))).toBe("root-hash-mismatch")
  })

  it("rejects a wrong record count", async () => {
    const { secret, parcel } = await assemble((rootHash, recordCount) => ({ recordCount: recordCount + 1, rootHash }))
    expect(await outcome(decryptAll(secret, parcel))).toBe("record-count-mismatch")
  })
})

describe("resume after the source changed", () => {
  it("never reuses a nonce, and the recipient rejects the mixed result at the trailer", async () => {
    const secret = new Uint8Array(32).fill(10)
    const original = bytesOf(3 * size, 1)
    const edited = original.slice()
    edited[2 * size + 5] = (edited[2 * size + 5] ?? 0) ^ 0xff
    const firstAttempt = await encryptAll({ secret, data: original, recordSizeExponent: exponent })
    const salt = firstAttempt.slice(6, 22)
    const resumed = await encryptAll({ secret, data: edited, recordSizeExponent: exponent, salt })
    const layout = layoutOf(singleFileManifest(3 * size), exponent)
    const changed = layout.data[2]
    if (changed === undefined) throw new Error("fixture layout")
    // The same record index resealed with different plaintext carries a different synthetic nonce.
    expect(Buffer.from(firstAttempt.subarray(changed.start, changed.start + 7)).equals(Buffer.from(resumed.subarray(changed.start, changed.start + 7)))).toBe(
      false,
    )
    // Records 0 and 1 came from the first attempt, record 2 and the trailer from the resumed one.
    const mixed = concatBytes(firstAttempt.subarray(0, changed.start), resumed.subarray(changed.start))
    expect(await outcome(decryptAll(secret, mixed))).toBe("accepted")
    // When the sender edits a record the recipient already has, the trailer's root (over the current source) exposes it.
    const earlyEdit = original.slice()
    earlyEdit[5] = (earlyEdit[5] ?? 0) ^ 0xff
    const resumedAfterEarlyEdit = await encryptAll({ secret, data: earlyEdit, recordSizeExponent: exponent, salt })
    const mixedEarly = concatBytes(firstAttempt.subarray(0, changed.start), resumedAfterEarlyEdit.subarray(changed.start))
    expect(await outcome(decryptAll(secret, mixedEarly))).toBe("root-hash-mismatch")
  })
})
