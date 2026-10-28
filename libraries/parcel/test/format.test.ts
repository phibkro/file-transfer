import fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import {
  constantTimeEqual,
  createManifest,
  decodeBase64Url,
  decodeHeader,
  decodeLinkSecret,
  decodeManifestPlaintext,
  deriveRoomToken,
  encodeBase64Url,
  encodeHeader,
  encodeLinkSecret,
  encodeManifestPlaintext,
  fromHex,
  hashRoomToken,
  headerLength,
  headerMagic,
  isSafeRelativeName,
  keyCommitmentLength,
  leafHash,
  MerkleFrontier,
  merkleRoot,
  recordNonce,
  recordSize,
  saltLength,
  toHex,
  validateManifest,
} from "../src/index.ts"
import { outcome } from "./support.ts"

describe("constants", () => {
  it("the header layout adds up to the documented 54 bytes", () => {
    expect(headerMagic.length + 1 + 1 + saltLength + keyCommitmentLength).toBe(headerLength)
  })

  it("record sizes are powers of two from 2^12 to 2^22", () => {
    expect(recordSize(16)).toBe(65536)
    expect(() => recordSize(11)).toThrow()
    expect(() => recordSize(23)).toThrow()
  })

  it("nonces are an 11-byte big-endian counter then the final flag", () => {
    expect(toHex(recordNonce(0, false))).toBe("000000000000000000000000")
    expect(toHex(recordNonce(258, true))).toBe("000000000000000000010201")
    expect(toHex(recordNonce(Number.MAX_SAFE_INTEGER, false))).toBe("000000001fffffffffffff00")
  })
})

describe("link secret", () => {
  it("round trips through base64url and rejects other encodings", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (secret) => {
        const fragment = encodeLinkSecret(secret)
        expect(fragment).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(Array.from(decodeLinkSecret(`#${fragment}`))).toEqual(Array.from(secret))
      }),
    )
    expect(() => decodeLinkSecret("AAAA")).toThrow()
    expect(() => decodeLinkSecret(`${"A".repeat(42)}B`)).toThrow()
    expect(() => decodeBase64Url("AA==")).toThrow()
    expect(encodeBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8")
  })
})

describe("room token", () => {
  it("is deterministic and 32 bytes", async () => {
    const secret = new Uint8Array(32).fill(7)
    const first = await deriveRoomToken(secret)
    expect(first.length).toBe(32)
    expect(toHex(first)).toBe(toHex(await deriveRoomToken(secret)))
  })

  it("different secrets give different token hashes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.uint8Array({ minLength: 32, maxLength: 32 }), async (left, right) => {
        fc.pre(toHex(left) !== toHex(right))
        expect(constantTimeEqual(await hashRoomToken(await deriveRoomToken(left)), await hashRoomToken(await deriveRoomToken(right)))).toBe(false)
      }),
      { numRuns: 30 },
    )
  })
})

describe("header", () => {
  const fields = { recordSizeExponent: 16, salt: new Uint8Array(16).fill(1), keyCommitment: new Uint8Array(32).fill(2) }

  it("round trips", () => {
    const header = encodeHeader(fields)
    expect(header.bytes.length).toBe(54)
    expect(toHex(decodeHeader(header.bytes).salt)).toBe(toHex(fields.salt))
  })

  it("rejects bad magic, versions and exponents", async () => {
    const bytes = encodeHeader(fields).bytes
    const with_ = (offset: number, value: number) => {
      const copy = bytes.slice()
      copy[offset] = value
      return copy
    }
    expect(await outcome(Promise.resolve().then(() => decodeHeader(with_(0, 0))))).toBe("invalid-header")
    expect(await outcome(Promise.resolve().then(() => decodeHeader(with_(4, 2))))).toBe("unsupported-version")
    expect(await outcome(Promise.resolve().then(() => decodeHeader(with_(5, 11))))).toBe("invalid-record-size")
    expect(await outcome(Promise.resolve().then(() => decodeHeader(bytes.subarray(0, 53))))).toBe("invalid-header")
  })
})

describe("manifest", () => {
  it("accepts safe relative names and rejects the rest", () => {
    for (const name of ["a", "folder/file.txt", "ünïcode/文件", ".hidden", "a..b"]) expect(isSafeRelativeName(name)).toBe(true)
    for (const name of ["", "/absolute", "a//b", "../up", "a/./b", "a/..", "back\\slash", "nul\u0000", "tab\t", "trailing/"])
      expect(isSafeRelativeName(name)).toBe(false)
  })

  it("rejects duplicate names, wrong totals, unknown fields and other versions", async () => {
    const file = { name: "a", size: 1, mediaType: "" }
    expect(await outcome(Promise.resolve().then(() => createManifest([file, file])))).toBe("invalid-manifest")
    expect(await outcome(Promise.resolve().then(() => validateManifest({ version: 1, files: [file], totalSize: 2 })))).toBe("invalid-manifest")
    expect(await outcome(Promise.resolve().then(() => validateManifest({ version: 1, files: [file], totalSize: 1, extra: true })))).toBe("invalid-manifest")
    expect(await outcome(Promise.resolve().then(() => validateManifest({ version: 2, files: [file], totalSize: 1 })))).toBe("invalid-manifest")
    expect(await outcome(Promise.resolve().then(() => validateManifest({ version: 1, files: [{ ...file, size: -1 }], totalSize: -1 })))).toBe(
      "invalid-manifest",
    )
  })

  it("pads to one record, round trips, and rejects non-zero padding or oversize manifests", async () => {
    const manifest = createManifest([{ name: "x.zip", size: 10_000_000_000, mediaType: "application/zip" }])
    const plaintext = encodeManifestPlaintext(manifest, 4096)
    expect(plaintext.length).toBe(4096)
    expect(decodeManifestPlaintext(plaintext)).toEqual(manifest)
    const dirty = plaintext.slice()
    dirty[4095] = 1
    expect(await outcome(Promise.resolve().then(() => decodeManifestPlaintext(dirty)))).toBe("invalid-manifest")
    const many = createManifest(Array.from({ length: 200 }, (_, index) => ({ name: `file-${index}.bin`, size: 1, mediaType: "" })))
    expect(await outcome(Promise.resolve().then(() => encodeManifestPlaintext(many, 4096)))).toBe("invalid-manifest")
  })
})

describe("Merkle tree (RFC 6962)", () => {
  // Leaf inputs and roots from transparency-dev/merkle, testonly/constants.go.
  const leaves = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"].map(fromHex)
  const roots = [
    "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
    "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
    "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
    "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
    "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
    "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
    "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
  ]

  it("matches the reference roots for 1 to 8 leaves, directly and incrementally", async () => {
    const frontier = new MerkleFrontier()
    for (const [index, leaf] of leaves.entries()) {
      await frontier.append(leaf)
      expect(toHex(await frontier.root())).toBe(roots[index])
      expect(toHex(await merkleRoot(leaves.slice(0, index + 1)))).toBe(roots[index])
    }
  })

  it("the frontier equals the direct definition for any leaves, also after snapshot and restore", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.uint8Array({ maxLength: 8 }), { minLength: 1, maxLength: 40 }), fc.nat(), async (input, cut) => {
        const split = cut % input.length
        let frontier = new MerkleFrontier()
        for (const leaf of input.slice(0, split)) await frontier.append(leaf)
        frontier = MerkleFrontier.restore(frontier.snapshot())
        for (const leaf of input.slice(split)) await frontier.appendLeafHash(await leafHash(leaf))
        expect(frontier.leafCount).toBe(input.length)
        expect(toHex(await frontier.root())).toBe(toHex(await merkleRoot(input)))
      }),
      { numRuns: 60 },
    )
  })
})
