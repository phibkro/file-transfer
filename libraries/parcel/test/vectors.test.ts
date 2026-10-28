import { describe, expect, it } from "vite-plus/test"
import { concatBytes, decodeManifestJson, fromHex } from "../src/index.ts"
import { decryptAll, outcome, outcomeOf } from "./support.ts"
import { generateRejections, generateVectors, plaintextByte, secret } from "./vectors/generate.ts"
import rejections from "./vectors/rejections.json" with { type: "json" }
import vectors from "./vectors/vectors.json" with { type: "json" }

describe("test vectors", () => {
  it("the implementation still produces vectors.json and rejections.json exactly (changing them means a new parcel version)", async () => {
    expect(JSON.parse(JSON.stringify(await generateVectors()))).toEqual(vectors)
    expect(JSON.parse(JSON.stringify(await generateRejections()))).toEqual(rejections)
  })

  it("every positive vector decrypts to its plaintext", async () => {
    for (const vectorCase of vectors.cases) {
      const parcel = concatBytes(
        fromHex(vectorCase.header),
        ...vectorCase.manifestRecords.map(fromHex),
        ...vectorCase.dataRecords.map(fromHex),
        fromHex(vectorCase.trailer),
      )
      const { manifest, plaintext } = await decryptAll(secret, parcel)
      expect(manifest).toEqual(vectorCase.manifest)
      expect(plaintext.length).toBe(vectorCase.manifest.totalSize)
      expect(plaintext.every((byte, index) => byte === plaintextByte(index))).toBe(true)
    }
  })

  it("every rejection vector is rejected with its reason", async () => {
    for (const manifestCase of rejections.manifests) {
      expect([manifestCase.name, await outcomeOf(() => decodeManifestJson(fromHex(manifestCase.json)))]).toEqual([manifestCase.name, manifestCase.reason])
    }
    for (const parcelCase of rejections.parcels) {
      expect([parcelCase.name, await outcome(decryptAll(fromHex(parcelCase.secret), fromHex(parcelCase.parcel)))]).toEqual([parcelCase.name, parcelCase.reason])
    }
  })
})
