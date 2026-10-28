import { describe, expect, it } from "vite-plus/test"
import { concatBytes, fromHex } from "../src/index.ts"
import { decryptAll } from "./support.ts"
import { generateVectors, plaintextByte, secret } from "./vectors/generate.ts"
import vectors from "./vectors/vectors.json" with { type: "json" }

describe("test vectors", () => {
  it("the implementation still produces vectors.json exactly (changing it means a new format version)", async () => {
    expect(JSON.parse(JSON.stringify(await generateVectors()))).toEqual(vectors)
  })

  it("every vector decrypts to its plaintext", async () => {
    for (const vectorCase of vectors.cases) {
      const ciphertext = concatBytes(
        fromHex(vectorCase.header),
        fromHex(vectorCase.manifestRecord),
        ...vectorCase.dataRecords.map(fromHex),
        fromHex(vectorCase.trailer),
      )
      const { manifest, plaintext } = await decryptAll(secret, ciphertext)
      expect(manifest).toEqual(vectorCase.manifest)
      expect(plaintext.every((byte, index) => byte === plaintextByte(index))).toBe(true)
      expect(plaintext.length).toBe(vectorCase.manifest.totalSize)
    }
  })
})
