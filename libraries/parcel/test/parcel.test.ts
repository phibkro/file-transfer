import * as fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import {
  concatBytes,
  constantTimeEqual,
  createManifest,
  createSalt,
  decodeBase64Url,
  decodeHeader,
  decodeLinkSecret,
  decodeManifestJson,
  decodeManifestStream,
  deriveParcelKeys,
  deriveRoomToken,
  encodeBase64Url,
  encodeHeader,
  encodeLinkSecret,
  encodeManifestJson,
  encodeManifestStream,
  fromHex,
  hashRoomToken,
  headerLength,
  headerMagic,
  isValidMediaType,
  isWindowsDeviceName,
  keyCommitmentLength,
  auditPath,
  checkNormalizer,
  foldAuditPath,
  leafHash,
  manifestRecordCount,
  manifestRecordSize,
  merkleRoot,
  treeHash,
  nameCollision,
  nameKey,
  nameProblem,
  openRecord,
  recordNonce,
  recordSize,
  saltLength,
  sealRecord,
  toHex,
  validateManifest,
} from "../src/index.ts"
import { outcome, outcomeOf } from "./support.ts"

const textEncoder = new TextEncoder()

/** isWindowsDeviceName as it was before the linear scan, the reference its replacement must agree with. */
const previousIsWindowsDeviceName = (segment: string): boolean => {
  const stem = (segment.split(".")[0] ?? "").replace(/ +$/u, "").replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase())

  return ["con", "prn", "aux", "nul"].includes(stem) || /^(?:com|lpt)[1-9¹²³]$/u.test(stem)
}

describe("constants", () => {
  it("the header layout adds up to the documented 58 bytes", () => {
    expect(headerMagic.length + 1 + 1 + 4 + saltLength + keyCommitmentLength).toBe(headerLength)
  })

  it("record sizes are powers of two from 2^12 to 2^22", () => {
    expect(recordSize(16)).toBe(65_536)
    expect(() => recordSize(11)).toThrow()
    expect(() => recordSize(23)).toThrow()
  })

  it("the manifest takes the smallest power of two of 4 KiB records that holds the contract terms and the JSON", () => {
    expect([0, 4052, 4053, 8148, 8149, 3 * 4096, 2 ** 24 - 44].map(manifestRecordCount)).toEqual([1, 1, 2, 2, 4, 4, 4096])
    expect(() => manifestRecordCount(2 ** 24 - 43)).toThrow()
  })

  it("nonces are the counter in 5 big-endian bytes, then the 7 synthetic bytes", () => {
    const synthetic = new Uint8Array(7).fill(0xaa)
    expect(toHex(recordNonce(0, synthetic))).toBe("0000000000aaaaaaaaaaaaaa")
    expect(toHex(recordNonce(258, synthetic))).toBe("0000000102aaaaaaaaaaaaaa")
    expect(toHex(recordNonce(2 ** 40 - 1, synthetic))).toBe("ffffffffffaaaaaaaaaaaaaa")
    expect(() => recordNonce(2 ** 40, synthetic)).toThrow()
  })
})

describe("link secret", () => {
  it("round trips through base64url and rejects other encodings", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (secret) => {
        const fragment = encodeLinkSecret(secret)
        expect(fragment).toMatch(/^[A-Za-z0-9_-]{43}$/u)
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
  const fields = { recordSizeExponent: 16, sequence: 0x01_02_03_04, salt: new Uint8Array(16).fill(1), keyCommitment: new Uint8Array(32).fill(2) }

  it("round trips", () => {
    const header = encodeHeader(fields)
    expect(header.bytes.length).toBe(58)
    expect(toHex(header.bytes.subarray(6, 10))).toBe("01020304")
    expect(decodeHeader(header.bytes).sequence).toBe(0x01_02_03_04)
    expect(toHex(decodeHeader(header.bytes).salt)).toBe(toHex(fields.salt))
  })

  it("rejects bad magic, versions and exponents", async () => {
    const { bytes } = encodeHeader(fields)

    const changed = (offset: number, value: number) => {
      const copy = bytes.slice()
      copy[offset] = value

      return copy
    }

    expect(await outcomeOf(() => decodeHeader(changed(0, 0)))).toBe("invalid-header")
    expect(await outcomeOf(() => decodeHeader(changed(4, 2)))).toBe("unsupported-version")
    expect(await outcomeOf(() => decodeHeader(changed(5, 11)))).toBe("invalid-record-size")
    expect(await outcomeOf(() => decodeHeader(bytes.subarray(0, 57)))).toBe("invalid-header")
  })
})

describe("name profile", () => {
  it("accepts portable relative names", () => {
    for (const name of ["a", "folder/file.txt", "ünïcode/文件", ".hidden", "a..b", "console", "com0", "lpt10.txt", "nul-terminated", "🙂.png"]) {
      expect(nameProblem(name)).toBeUndefined()
    }
  })

  it("rejects each rule's violations", () => {
    const rejected = [
      "",
      "/absolute",
      "a//b",
      "trailing/",
      "../up",
      "a/./b",
      "a/..",
      "back\\slash",
      "colon:stream",
      'quote"',
      "star*",
      "question?",
      "less<",
      "greater>",
      "pipe|",
      "nul\u0000",
      "tab\t",
      "next\u0085line",
      "invoice_‮cod.exe",
      "zero​width",
      "byte﻿order",
      "line\u2028separator",
      "lone\uD800",
      "unassigned\u0897",
      "noncharacter\uFDD0",
      "plane\u{10FFFF}",
      "café",
      "trailing.",
      "trailing ",
      "CON",
      "con.txt",
      "nul .txt",
      "Com1",
      "lpt¹",
      "COM³.log",
      "x".repeat(256),
      "é".repeat(128),
      `${"a/".repeat(2049)}b`,
    ]

    for (const name of rejected) {
      expect([name, nameProblem(name)]).not.toEqual([name, undefined])
    }
  })

  it("rejects code points unassigned in Unicode 15.1, so every normalizer at 15.1 or later agrees", () => {
    // U+0897 was assigned in Unicode 16.0 and changes NFC there; this runtime knows it, Unicode 15.1 does not.
    expect(nameProblem("pepet\u0897")).toBe("contains the forbidden character U+0897")
    expect(nameProblem("x\u0301\u0897")).toBe("contains the forbidden character U+0897")
    expect(nameProblem("\u{1FAE9}")).toBe("contains the forbidden character U+1FAE9")
    expect(nameProblem("\u{1FAE8}")).toBeUndefined()
  })

  it("refuses a normalizer older than Unicode 15.0 with a typed error", async () => {
    expect(
      await outcomeOf(() => {
        checkNormalizer((text) => text)
      }),
    ).toBe("unsupported-runtime")
    expect(
      await outcomeOf(() => {
        checkNormalizer()
      }),
    ).toBe("accepted")
  })

  it("treats device names as Windows does: the part before the first dot, trailing spaces removed", () => {
    expect(["aux", "AUX.tar.gz", "prn ", "com9", "LPT²"].every(isWindowsDeviceName)).toBe(true)
    expect(["auxiliary", "com", "com10", "lpt0", "x.con"].some(isWindowsDeviceName)).toBe(false)
  })

  it("decides device names exactly as the regular expression it replaced did", () => {
    const pieces = fc.constantFrom("aux", "AUX", "Com1", "lpt²", "nul", " ", "  ", ".", "x", "\t", "\u00A0", "\u3000")

    fc.assert(
      fc.property(fc.array(pieces, { maxLength: 8 }), (parts) => {
        const segment = parts.join("")

        expect(isWindowsDeviceName(segment)).toBe(previousIsWindowsDeviceName(segment))
      }),
      { numRuns: 2000 },
    )
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (segment) => {
        expect(isWindowsDeviceName(segment)).toBe(previousIsWindowsDeviceName(segment))
      }),
    )
  })

  it("takes linear time on a long run of spaces", () => {
    const started = performance.now()

    expect(isWindowsDeviceName(`aux${" ".repeat(200_000)}x`)).toBe(false)
    expect(isWindowsDeviceName(`aux${" ".repeat(200_000)}`)).toBe(true)
    // The regular expression took 6.6 s for 100,000 spaces, growing with the square of the length.
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it("compares names after full case folding and NFC, and forbids a file that is also a folder", () => {
    expect(nameKey("STRASSE")).toBe(nameKey("straße"))
    expect(nameCollision(["Report.pdf", "report.PDF"])).toBeDefined()
    expect(nameCollision(["straße.txt", "STRASSE.TXT"])).toBeDefined()
    expect(nameCollision(["a", "a/b"])).toBeDefined()
    expect(nameCollision(["A", "a/b"])).toBeDefined()
    expect(nameCollision(["a/b", "a/c", "ab"])).toBeUndefined()
  })
})

describe("media types", () => {
  it("accepts empty or lowercase type/subtype and rejects the rest", () => {
    for (const valid of ["", "text/plain", "image/svg+xml", "application/vnd.ms-excel", "text/html"]) {
      expect(isValidMediaType(valid)).toBe(true)
    }

    for (const invalid of ["Text/Plain", "text", "text/plain; charset=utf-8", "a\r\nX-Injected: 1/b", "/plain", "text/", `a/${"b".repeat(126)}`]) {
      expect([invalid, isValidMediaType(invalid)]).toEqual([invalid, false])
    }
  })
})

describe("canonical manifest", () => {
  const manifest = createManifest([
    { name: "photos/a.jpg", size: 5000, mediaType: "image/jpeg" },
    { name: "日本語.txt", size: 0, mediaType: "" },
  ])

  it("has one byte form", () => {
    expect(new TextDecoder().decode(encodeManifestJson(manifest))).toBe(
      '{"version":1,"files":[{"name":"photos/a.jpg","size":5000,"mediaType":"image/jpeg"},{"name":"日本語.txt","size":0,"mediaType":""}],"totalSize":5000}',
    )
    expect(decodeManifestJson(encodeManifestJson(manifest))).toEqual(manifest)
  })

  it("rejects every other spelling of the same content and every rule violation", async () => {
    const file = '{"name":"a","size":1,"mediaType":""}'

    const spellings = [
      `﻿{"version":1,"files":[${file}],"totalSize":1}`,
      `{"version":1, "files":[${file}],"totalSize":1}`,
      `{"files":[${file}],"version":1,"totalSize":1}`,
      `{"version":1,"files":[{"name":"../../etc/passwd","name":"a","size":1,"mediaType":""}],"totalSize":1}`,
      `{"version":1,"files":[{"name":"a","size":1e0,"mediaType":""}],"totalSize":1}`,
      `{"version":1,"files":[{"name":"a","size":1.0,"mediaType":""}],"totalSize":1}`,
      `{"version":1,"files":[{"name":"a","size":-0,"mediaType":""}],"totalSize":0}`,
      `{"version":1,"files":[{"name":"\\u0061","size":1,"mediaType":""}],"totalSize":1}`,
      `{"version":1,"files":[{"name":"a\\ud800","size":1,"mediaType":""}],"totalSize":1}`,
      `{"version":1,"files":[${file}],"totalSize":1,"extra":true}`,
      `{"version":1,"files":[],"totalSize":0}`,
      `{"version":1,"files":[{"name":"a","size":${2 ** 40},"mediaType":""}],"totalSize":${2 ** 40}}`,
      `{"version":1,"files":[${file}],"totalSize":2}`,
    ]

    for (const text of spellings) {
      expect([text, await outcomeOf(() => decodeManifestJson(textEncoder.encode(text)))]).toEqual([text, "invalid-manifest"])
    }
  })

  it("round trips any valid manifest, and validation equals decoding its canonical form", () => {
    // Valid names only: the pattern alone can produce reserved device names such as "con.txt", which the profile rejects.
    const nameArbitrary = fc.stringMatching(/^[a-z0-9_-]{1,12}(?:\/[a-z0-9_-]{1,12}){0,2}\.(?:txt|bin)$/u).filter((name) => nameProblem(name) === undefined)
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ name: nameArbitrary, size: fc.nat({ max: 2 ** 30 }), mediaType: fc.constantFrom("", "text/plain") }), {
          minLength: 1,
          maxLength: 20,
          selector: (file) => nameKey(file.name),
        }),
        (files) => {
          fc.pre(nameCollision(files.map((file) => file.name)) === undefined)
          const created = createManifest(files)
          expect(decodeManifestJson(encodeManifestJson(created))).toEqual(created)
          expect(validateManifest(JSON.parse(new TextDecoder().decode(encodeManifestJson(created))))).toEqual(created)
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe("manifest stream", () => {
  const terms = { recordCount: 3, rootHash: new Uint8Array(32).fill(9) }

  it("carries the contract terms and the JSON, padded to whole records, and decodes back", () => {
    const small = createManifest([{ name: "a", size: 1, mediaType: "" }])
    const plaintext = encodeManifestStream(small, terms)
    expect(plaintext.length).toBe(manifestRecordSize)
    expect(toHex(plaintext.subarray(0, 8))).toBe("0000000000000003")
    expect(decodeManifestStream(plaintext)).toEqual({ manifest: small, recordCount: 3, rootHash: terms.rootHash })

    const large = createManifest(
      Array.from({ length: 200 }, (_, index) => ({ name: `folder/file-${index}.bin`, size: index, mediaType: "application/octet-stream" })),
    )

    const stream = encodeManifestStream(large, terms)
    expect(stream.length).toBe(manifestRecordCount(encodeManifestJson(large).length) * manifestRecordSize)
    expect(stream.length / manifestRecordSize).toBeGreaterThan(1)
    expect(decodeManifestStream(stream).manifest).toEqual(large)
  })

  it("rejects non-zero padding, a record count that is not the minimal power of two, and a length beyond the limit", async () => {
    const plaintext = encodeManifestStream(createManifest([{ name: "a", size: 1, mediaType: "" }]), terms)
    const dirty = plaintext.slice()
    dirty[manifestRecordSize - 1] = 1
    expect(await outcomeOf(() => decodeManifestStream(dirty))).toBe("invalid-manifest")
    expect(await outcomeOf(() => decodeManifestStream(concatBytes(plaintext, new Uint8Array(manifestRecordSize))))).toBe("invalid-manifest")
    const lying = plaintext.slice()
    new DataView(lying.buffer).setUint32(40, 2 ** 24)
    expect(await outcomeOf(() => decodeManifestStream(lying))).toBe("invalid-manifest")
  })

  it("reports the first failing check in the listed order: invalid JSON before an out-of-range record count", async () => {
    const plaintext = encodeManifestStream(createManifest([{ name: "a", size: 1, mediaType: "" }]), terms)
    new DataView(plaintext.buffer).setBigUint64(0, 2n ** 63n)
    expect(await outcomeOf(() => decodeManifestStream(plaintext))).toBe("record-count-mismatch")
    plaintext[44] = 0x20
    expect(await outcomeOf(() => decodeManifestStream(plaintext))).toBe("invalid-manifest")
  })
})

const recordsSetup = async () => {
  const keys = await deriveParcelKeys(new Uint8Array(32).fill(3), createSalt())
  const header = encodeHeader({ recordSizeExponent: 16, sequence: 0, salt: new Uint8Array(16), keyCommitment: keys.keyCommitment })

  return { keys, header: header.bytes }
}

describe("records", () => {
  it("resealing the same plaintext gives the same bytes; different plaintext at the same counter gives a different nonce", async () => {
    const { keys, header } = await recordsSetup()
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 64 }), fc.uint8Array({ maxLength: 64 }), fc.nat({ max: 2 ** 20 }), async (first, second, counter) => {
        fc.pre(toHex(first) !== toHex(second))
        const position = { counter, isFinal: false }
        const sealedFirst = await sealRecord(keys.content, header, position, first)
        expect(toHex(await sealRecord(keys.content, header, position, first))).toBe(toHex(sealedFirst))
        const sealedSecond = await sealRecord(keys.content, header, position, second)
        expect(toHex(sealedFirst.subarray(0, 7))).not.toBe(toHex(sealedSecond.subarray(0, 7)))
        expect(toHex(await openRecord(keys.content, header, position, sealedFirst, "record"))).toBe(toHex(first))
      }),
      { numRuns: 50 },
    )
  })

  it("binds the counter, the final flag, the header and the stream", async () => {
    const { keys, header } = await recordsSetup()
    const record = await sealRecord(keys.content, header, { counter: 5, isFinal: false }, textEncoder.encode("hello"))
    const otherHeader = header.slice()
    otherHeader[5] = 17
    expect(await outcome(openRecord(keys.content, header, { counter: 6, isFinal: false }, record, "r"))).toBe("authentication-failed")
    expect(await outcome(openRecord(keys.content, header, { counter: 5, isFinal: true }, record, "r"))).toBe("authentication-failed")
    expect(await outcome(openRecord(keys.content, otherHeader, { counter: 5, isFinal: false }, record, "r"))).toBe("authentication-failed")
    expect(await outcome(openRecord(keys.manifest, header, { counter: 5, isFinal: false }, record, "r"))).toBe("authentication-failed")
  })

  it("rejects a record whose prefix is not the synthetic value of its plaintext, even with a valid tag", async () => {
    const { keys, header } = await recordsSetup()
    const plaintext = textEncoder.encode("hello")
    const position = new Uint8Array(9)
    new DataView(position.buffer).setBigUint64(0, 5n)
    const prefix = new Uint8Array(7).fill(0x42)

    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: recordNonce(5, prefix), additionalData: concatBytes(header, position), tagLength: 128 },
        keys.content.aeadKey,
        plaintext,
      ),
    )

    expect(await outcome(openRecord(keys.content, header, { counter: 5, isFinal: false }, concatBytes(prefix, sealed), "r"))).toBe("authentication-failed")
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

  it("matches the reference roots for 1 to 8 leaves, directly and over leaf hashes", async () => {
    for (const [index] of leaves.entries()) {
      const prefix = leaves.slice(0, index + 1)
      expect(toHex(await merkleRoot(prefix))).toBe(roots[index])
      expect(toHex(await treeHash(await Promise.all(prefix.map(leafHash))))).toBe(roots[index])
    }
  })

  it("pages of any power-of-two size are nodes: the tree over page roots is the root, and every page's audit path folds to it", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ maxLength: 8 }), { minLength: 1, maxLength: 70 }),
        fc.integer({ min: 0, max: 4 }),
        async (input, pageExponent) => {
          const pageSize = 2 ** pageExponent
          const labels = await Promise.all(input.map(leafHash))
          const root = await merkleRoot(input)
          const pageCount = Math.ceil(labels.length / pageSize)

          const pageRoots = await Promise.all(
            Array.from({ length: pageCount }, async (_, page) => await treeHash(labels, page * pageSize, Math.min(labels.length, (page + 1) * pageSize))),
          )

          expect(toHex(await treeHash(pageRoots))).toBe(toHex(root))

          for (let page = 0; page < pageCount; page++) {
            const path = auditPath(pageCount, page)
            const siblings = await Promise.all(path.map(async (sibling) => await treeHash(pageRoots, sibling.start, sibling.end)))
            expect(toHex(await foldAuditPath(pageRoots[page] ?? new Uint8Array(32), path, siblings))).toBe(toHex(root))

            if (siblings.length > 0) {
              const wrong = siblings.map((hash, index) => (index === 0 ? new Uint8Array(32) : hash))
              expect(toHex(await foldAuditPath(pageRoots[page] ?? new Uint8Array(32), path, wrong))).not.toBe(toHex(root))
            }
          }
        },
      ),
      { numRuns: 60 },
    )
  })
})
