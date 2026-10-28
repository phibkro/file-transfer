import fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import { authenticationTagLength, concatBytes, createEncryptor, createManifest, headerLength, merkleRoot, trailerCiphertextLength } from "../src/index.ts"
import { decryptAll, encryptAll, outcome, singleFileManifest } from "./support.ts"

const secretArbitrary = fc.uint8Array({ minLength: 32, maxLength: 32 })
const exponent = 12
const size = 2 ** exponent
const manifestRecordLength = size + authenticationTagLength

/** Sizes around the record boundaries the spec calls out, plus random ones, up to five records. */
const lengthArbitrary = fc.oneof(fc.constantFrom(0, 1, size - 1, size, size + 1, 3 * size - 7), fc.integer({ min: 0, max: 5 * size }))

const bytesOf = (length: number, seed: number) => Uint8Array.from({ length }, (_, index) => (index * 31 + seed) & 0xff)

/** Offsets of each data record and the trailer in a ciphertext stream. */
const layout = (ciphertext: Uint8Array) => {
  const dataStart = headerLength + manifestRecordLength
  const trailerStart = ciphertext.length - trailerCiphertextLength
  const records: Array<{ start: number; end: number }> = []
  for (let start = dataStart; start < trailerStart; start += size + authenticationTagLength) {
    records.push({ start, end: Math.min(start + size + authenticationTagLength, trailerStart) })
  }
  return { records, trailerStart }
}

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
          const ciphertext = await encryptAll({ secret, data, recordSizeExponent, chunkSize: encryptChunk })
          const recordCount = Math.max(1, Math.ceil(length / 2 ** recordSizeExponent))
          expect(ciphertext.length).toBe(headerLength + 2 ** recordSizeExponent + 16 + length + recordCount * 16 + trailerCiphertextLength)
          const { manifest, plaintext } = await decryptAll(secret, ciphertext, decryptChunk)
          expect(manifest.totalSize).toBe(length)
          expect(Buffer.from(plaintext).equals(Buffer.from(data))).toBe(true)
        },
      ),
      { numRuns: 60 },
    )
  })

  it("carries several files concatenated in manifest order", async () => {
    const manifest = createManifest([
      { name: "photos/a.jpg", size: 5000, mediaType: "image/jpeg" },
      { name: "empty.txt", size: 0, mediaType: "text/plain" },
      { name: "notes.md", size: 123, mediaType: "" },
    ])
    const secret = new Uint8Array(32).fill(9)
    const data = bytesOf(5123, 3)
    const result = await decryptAll(secret, await encryptAll({ secret, data, recordSizeExponent: exponent, manifest }))
    expect(result.manifest).toEqual(manifest)
    expect(result.plaintext.length).toBe(5123)
  })

  it("fresh salts make two encryptions of the same input differ", async () => {
    const secret = new Uint8Array(32).fill(1)
    const data = bytesOf(100, 0)
    const first = await encryptAll({ secret, data, recordSizeExponent: exponent })
    const second = await encryptAll({ secret, data, recordSizeExponent: exponent })
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
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
          const ciphertext = (await fixture(secret, length)).slice()
          const index = position % ciphertext.length
          ciphertext[index] = (ciphertext[index] ?? 0) ^ (1 << bit)
          expect(await outcome(decryptAll(secret, ciphertext))).not.toBe("accepted")
        },
      ),
      { numRuns: 80 },
    )
  })

  it("truncation at any byte, with 'truncated' at every record boundary", async () => {
    const secret = new Uint8Array(32).fill(2)
    const ciphertext = await fixture(secret, 2 * size + 100)
    await fc.assert(
      fc.asyncProperty(fc.nat(), async (cut) => {
        expect(await outcome(decryptAll(secret, ciphertext.subarray(0, cut % ciphertext.length)))).not.toBe("accepted")
      }),
      { numRuns: 60 },
    )
    const { records, trailerStart } = layout(ciphertext)
    for (const boundary of [headerLength, headerLength + manifestRecordLength, ...records.map((record) => record.end), trailerStart]) {
      expect(await outcome(decryptAll(secret, ciphertext.subarray(0, boundary)))).toBe("truncated")
    }
  })

  it("data after the trailer", async () => {
    const secret = new Uint8Array(32).fill(3)
    const ciphertext = await fixture(secret, 10)
    expect(await outcome(decryptAll(secret, concatBytes(ciphertext, new Uint8Array([0]))))).toBe("trailing-data")
  })

  it("reordered and duplicated records", async () => {
    const secret = new Uint8Array(32).fill(4)
    const ciphertext = await fixture(secret, 3 * size)
    const [first, second] = layout(ciphertext).records
    if (first === undefined || second === undefined) throw new Error("fixture needs two records")
    const swapped = ciphertext.slice()
    swapped.set(ciphertext.subarray(second.start, second.end), first.start)
    swapped.set(ciphertext.subarray(first.start, first.end), second.start)
    expect(await outcome(decryptAll(secret, swapped))).toBe("authentication-failed")
    const duplicated = ciphertext.slice()
    duplicated.set(ciphertext.subarray(first.start, first.end), second.start)
    expect(await outcome(decryptAll(secret, duplicated))).toBe("authentication-failed")
  })

  it("a data record and the trailer swapped (same length, different keys)", async () => {
    const secret = new Uint8Array(32).fill(5)
    // A last record of 40 plaintext bytes has the trailer's ciphertext length.
    const ciphertext = await fixture(secret, size + 40)
    const { records, trailerStart } = layout(ciphertext)
    const last = records.at(-1)
    if (last === undefined || last.end - last.start !== trailerCiphertextLength) throw new Error("fixture layout")
    const swapped = ciphertext.slice()
    swapped.set(ciphertext.subarray(trailerStart), last.start)
    swapped.set(ciphertext.subarray(last.start, last.end), trailerStart)
    expect(await outcome(decryptAll(secret, swapped))).toBe("authentication-failed")
  })

  it("a record spliced in from another transfer under the same secret", async () => {
    const secret = new Uint8Array(32).fill(6)
    const first = await fixture(secret, 2 * size)
    const second = await fixture(secret, 2 * size)
    const [record] = layout(first).records
    if (record === undefined) throw new Error("fixture layout")
    const spliced = first.slice()
    spliced.set(second.subarray(record.start, record.end), record.start)
    expect(await outcome(decryptAll(secret, spliced))).toBe("authentication-failed")
  })

  it("the wrong secret, before any record is opened", async () => {
    await fc.assert(
      fc.asyncProperty(secretArbitrary, secretArbitrary, async (secret, other) => {
        fc.pre(Buffer.from(secret).compare(Buffer.from(other)) !== 0)
        expect(await outcome(decryptAll(other, await fixture(secret, 100)))).toBe("key-commitment-mismatch")
      }),
      { numRuns: 20 },
    )
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
    return { secret, ciphertext: concatBytes(encryptor.header.bytes, await encryptor.sealManifest(), ...records, sealed) }
  }

  it("accepts the honest trailer", async () => {
    const { secret, ciphertext } = await assemble((rootHash, recordCount) => ({ recordCount, rootHash }))
    expect(await outcome(decryptAll(secret, ciphertext))).toBe("accepted")
  })

  it("rejects a wrong root hash", async () => {
    const { secret, ciphertext } = await assemble((_, recordCount) => ({ recordCount, rootHash: new Uint8Array(32) }))
    expect(await outcome(decryptAll(secret, ciphertext))).toBe("root-hash-mismatch")
  })

  it("rejects a wrong record count", async () => {
    const { secret, ciphertext } = await assemble((rootHash, recordCount) => ({ recordCount: recordCount + 1, rootHash }))
    expect(await outcome(decryptAll(secret, ciphertext))).toBe("record-count-mismatch")
  })
})
