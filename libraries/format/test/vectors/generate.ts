/**
 * Prints the v1 test vectors as JSON: `bun libraries/format/test/vectors/generate.ts > libraries/format/test/vectors/vectors.json`.
 * Inputs are fixed; `vectors.test.ts` regenerates and compares, and `verify.py` reproduces every byte independently.
 */
import { createEncryptor, createManifest, derivationInfo, deriveRoomToken, hashRoomToken, type Manifest, merkleRoot, toHex } from "../../src/index.ts"

export const secret = Uint8Array.from({ length: 32 }, (_, index) => index)
export const salt = Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index)
export const plaintextByte = (index: number) => index % 251

const textEncoder = new TextEncoder()

const hkdfBits = async (salt: Uint8Array<ArrayBuffer>, info: string) => {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"])
  return toHex(new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: textEncoder.encode(info) }, material, 256)))
}

const vectorCase = async (name: string, recordSizeExponent: number, manifest: Manifest) => {
  const size = 2 ** recordSizeExponent
  const plaintext = Uint8Array.from({ length: manifest.totalSize }, (_, index) => plaintextByte(index))
  const encryptor = await createEncryptor({ secret, salt, manifest, recordSizeExponent })
  const records: Array<Uint8Array> = []
  for (let index = 0; index < encryptor.recordCount; index++) {
    records.push(await encryptor.sealData(index, plaintext.subarray(index * size, Math.min((index + 1) * size, plaintext.length))))
  }
  const rootHash = await merkleRoot(records)
  const manifestRecord = await encryptor.sealManifest()
  const trailer = await encryptor.sealTrailer({ recordCount: encryptor.recordCount, rootHash })
  return {
    name,
    recordSizeExponent,
    manifest,
    recordCount: encryptor.recordCount,
    header: toHex(encryptor.header.bytes),
    manifestRecord: toHex(manifestRecord),
    dataRecords: records.map(toHex),
    trailer: toHex(trailer),
    rootHash: toHex(rootHash),
  }
}

export const generateVectors = async () => {
  const singleFile = (size: number) => createManifest([{ name: "vector.bin", size, mediaType: "application/octet-stream" }])
  const roomToken = await deriveRoomToken(secret)
  return {
    description: "Encrypted object format v1 test vectors (docs/format.md). Plaintext byte i is i mod 251, files concatenated in manifest order.",
    secret: toHex(secret),
    linkFragment: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    salt: toHex(salt),
    roomToken: toHex(roomToken),
    roomTokenHash: await hashRoomToken(roomToken),
    keys: {
      contentKey: await hkdfBits(salt, derivationInfo.contentKey),
      manifestKey: await hkdfBits(salt, derivationInfo.manifestKey),
      keyCommitment: await hkdfBits(salt, derivationInfo.keyCommitment),
    },
    cases: [
      await vectorCase("empty", 12, singleFile(0)),
      await vectorCase("one byte", 12, singleFile(1)),
      await vectorCase("one record minus one", 12, singleFile(4095)),
      await vectorCase("exactly one record", 12, singleFile(4096)),
      await vectorCase("one record plus one", 12, singleFile(4097)),
      await vectorCase("three records with a short tail", 12, singleFile(2 * 4096 + 100)),
      await vectorCase(
        "two files and an empty one",
        12,
        createManifest([
          { name: "folder/a.txt", size: 3000, mediaType: "text/plain" },
          { name: "empty", size: 0, mediaType: "" },
          { name: "b.bin", size: 2000, mediaType: "application/octet-stream" },
        ]),
      ),
      await vectorCase("default record size, one byte", 16, singleFile(1)),
    ],
  }
}

if (import.meta.main) console.log(JSON.stringify(await generateVectors(), null, 2))
