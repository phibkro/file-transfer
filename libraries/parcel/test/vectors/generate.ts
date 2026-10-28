/**
 * Prints the parcel v1 test vectors as JSON:
 *   bun libraries/parcel/test/vectors/generate.ts vectors > libraries/parcel/test/vectors/vectors.json
 *   bun libraries/parcel/test/vectors/generate.ts rejections > libraries/parcel/test/vectors/rejections.json
 * Inputs are fixed; `vectors.test.ts` regenerates and compares, and `verify.py` reproduces every positive byte and
 * rejects every negative case independently.
 */
import {
  concatBytes,
  createEncryptor,
  createManifest,
  derivationInfo,
  derivationSalt,
  deriveParcelKeys,
  deriveRoomToken,
  encodeManifestJson,
  hashRoomToken,
  headerLength,
  type Manifest,
  manifestRecordSize,
  merkleRoot,
  recordNonce,
  sealRecord,
  toHex,
} from "../../src/index.ts"

export const secret = Uint8Array.from({ length: 32 }, (_, index) => index)
export const salt = Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index)
export const plaintextByte = (index: number) => index % 251

const textEncoder = new TextEncoder()

const expandHex = async (label: string, withSalt: boolean) => {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"])
  const info = withSalt ? concatBytes(textEncoder.encode(label), salt) : textEncoder.encode(label)
  return toHex(new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: textEncoder.encode(derivationSalt), info }, material, 256)))
}

const plaintextOf = (manifest: Manifest) => Uint8Array.from({ length: manifest.totalSize }, (_, index) => plaintextByte(index))

const sealParcel = async (manifest: Manifest, recordSizeExponent: number) => {
  const size = 2 ** recordSizeExponent
  const plaintext = plaintextOf(manifest)
  const encryptor = await createEncryptor({ secret, salt, manifest, recordSizeExponent })
  const dataRecords: Array<Uint8Array> = []
  for (let index = 0; index < encryptor.recordCount; index++) {
    dataRecords.push(await encryptor.sealData(index, plaintext.subarray(index * size, Math.min((index + 1) * size, plaintext.length))))
  }
  const rootHash = await merkleRoot(dataRecords)
  return {
    encryptor,
    manifestRecords: await encryptor.sealManifest(),
    dataRecords,
    rootHash,
    trailer: await encryptor.sealTrailer({ recordCount: encryptor.recordCount, rootHash }),
  }
}

const vectorCase = async (name: string, recordSizeExponent: number, manifest: Manifest) => {
  const sealed = await sealParcel(manifest, recordSizeExponent)
  return {
    name,
    recordSizeExponent,
    manifest,
    manifestJson: new TextDecoder().decode(encodeManifestJson(manifest)),
    recordCount: sealed.encryptor.recordCount,
    header: toHex(sealed.encryptor.header.bytes),
    manifestRecords: sealed.manifestRecords.map(toHex),
    dataRecords: sealed.dataRecords.map(toHex),
    rootHash: toHex(sealed.rootHash),
    trailer: toHex(sealed.trailer),
  }
}

const singleFile = (size: number) => createManifest([{ name: "vector.bin", size, mediaType: "application/octet-stream" }])

export const generateVectors = async () => {
  const roomToken = await deriveRoomToken(secret)
  return {
    description: "Parcel v1 test vectors (docs/parcel.md). Plaintext byte i is i mod 251, files concatenated in manifest order.",
    secret: toHex(secret),
    linkFragment: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    salt: toHex(salt),
    roomToken: toHex(roomToken),
    roomTokenHash: await hashRoomToken(roomToken),
    keys: {
      contentKey: await expandHex(derivationInfo.contentKey, true),
      contentSyntheticKey: await expandHex(derivationInfo.contentSyntheticKey, true),
      manifestKey: await expandHex(derivationInfo.manifestKey, true),
      manifestSyntheticKey: await expandHex(derivationInfo.manifestSyntheticKey, true),
      keyCommitment: await expandHex(derivationInfo.keyCommitment, true),
    },
    cases: [
      await vectorCase("empty", 12, singleFile(0)),
      await vectorCase("one byte", 12, singleFile(1)),
      await vectorCase("one record minus one", 12, singleFile(4095)),
      await vectorCase("exactly one record", 12, singleFile(4096)),
      await vectorCase("one record plus one", 12, singleFile(4097)),
      await vectorCase("three records with a short tail", 12, singleFile(2 * 4096 + 100)),
      await vectorCase(
        "several files, non-ASCII names, an empty file",
        12,
        createManifest([
          { name: "mappe/blåbær.txt", size: 3000, mediaType: "text/plain" },
          { name: "空", size: 0, mediaType: "" },
          { name: "Ünïcödé/naïve café.bin", size: 2000, mediaType: "application/octet-stream" },
        ]),
      ),
      await vectorCase("largest record size, one byte", 22, singleFile(1)),
      await vectorCase(
        "manifest of two records",
        12,
        createManifest(
          Array.from({ length: 70 }, (_, index) => ({
            name: `folder/file-number-${String(index).padStart(3, "0")}.bin`,
            size: 1,
            mediaType: "application/octet-stream",
          })),
        ),
      ),
    ],
  }
}

/** Raw canonical-JSON candidates every receiver must reject, as bytes, with the reason. */
const manifestRejections: ReadonlyArray<readonly [string, string]> = [
  ["byte order mark", '﻿{"version":1,"files":[{"name":"a","size":1,"mediaType":""}],"totalSize":1}'],
  ["whitespace", '{"version":1, "files":[{"name":"a","size":1,"mediaType":""}],"totalSize":1}'],
  ["keys out of order", '{"files":[{"name":"a","size":1,"mediaType":""}],"version":1,"totalSize":1}'],
  ["duplicate key hiding a traversal", '{"version":1,"files":[{"name":"../../etc/passwd","name":"a","size":1,"mediaType":""}],"totalSize":1}'],
  ["exponent number", '{"version":1,"files":[{"name":"a","size":1e0,"mediaType":""}],"totalSize":1}'],
  ["fraction number", '{"version":1,"files":[{"name":"a","size":1.0,"mediaType":""}],"totalSize":1}'],
  ["negative zero", '{"version":1,"files":[{"name":"a","size":-0,"mediaType":""}],"totalSize":0}'],
  ["unnecessary escape", '{"version":1,"files":[{"name":"\\u0061","size":1,"mediaType":""}],"totalSize":1}'],
  ["lone surrogate", '{"version":1,"files":[{"name":"a\\ud800","size":1,"mediaType":""}],"totalSize":1}'],
  ["unknown key", '{"version":1,"files":[{"name":"a","size":1,"mediaType":""}],"totalSize":1,"extra":true}'],
  ["no files", '{"version":1,"files":[],"totalSize":0}'],
  ["total at the size limit", '{"version":1,"files":[{"name":"a","size":1099511627776,"mediaType":""}],"totalSize":1099511627776}'],
  ["wrong total", '{"version":1,"files":[{"name":"a","size":1,"mediaType":""}],"totalSize":2}'],
  ["name not in NFC", '{"version":1,"files":[{"name":"café","size":1,"mediaType":""}],"totalSize":1}'],
  ["case collision", '{"version":1,"files":[{"name":"Report.pdf","size":1,"mediaType":""},{"name":"report.PDF","size":1,"mediaType":""}],"totalSize":2}'],
  ["case-folding collision", '{"version":1,"files":[{"name":"straße","size":1,"mediaType":""},{"name":"STRASSE","size":1,"mediaType":""}],"totalSize":2}'],
  ["file and folder", '{"version":1,"files":[{"name":"a","size":1,"mediaType":""},{"name":"a/b","size":1,"mediaType":""}],"totalSize":2}'],
  ["traversal", '{"version":1,"files":[{"name":"../x","size":1,"mediaType":""}],"totalSize":1}'],
  ["absolute path", '{"version":1,"files":[{"name":"/x","size":1,"mediaType":""}],"totalSize":1}'],
  ["right-to-left override", '{"version":1,"files":[{"name":"invoice_‮cod.exe","size":1,"mediaType":""}],"totalSize":1}'],
  ["C1 control", '{"version":1,"files":[{"name":"a\u0085b","size":1,"mediaType":""}],"totalSize":1}'],
  ["zero-width space", '{"version":1,"files":[{"name":"​","size":1,"mediaType":""}],"totalSize":1}'],
  ["Windows device name", '{"version":1,"files":[{"name":"CON","size":1,"mediaType":""}],"totalSize":1}'],
  ["Windows device name with extension", '{"version":1,"files":[{"name":"docs/lpt¹.txt","size":1,"mediaType":""}],"totalSize":1}'],
  ["alternate data stream colon", '{"version":1,"files":[{"name":"a.txt:Zone.Identifier","size":1,"mediaType":""}],"totalSize":1}'],
  ["trailing dot", '{"version":1,"files":[{"name":"trailing.","size":1,"mediaType":""}],"totalSize":1}'],
  ["trailing space", '{"version":1,"files":[{"name":"trailing ","size":1,"mediaType":""}],"totalSize":1}'],
  ["segment longer than 255 bytes", `{"version":1,"files":[{"name":"${"x".repeat(256)}","size":1,"mediaType":""}],"totalSize":1}`],
  ["uppercase media type", '{"version":1,"files":[{"name":"a","size":1,"mediaType":"Text/Plain"}],"totalSize":1}'],
  ["media type with parameters", '{"version":1,"files":[{"name":"a","size":1,"mediaType":"text/plain; charset=utf-8"}],"totalSize":1}'],
  ["media type with a line break", '{"version":1,"files":[{"name":"a","size":1,"mediaType":"a\\r\\nX: 1/b"}],"totalSize":1}'],
]

const sealManifestStream = async (keys: Awaited<ReturnType<typeof deriveParcelKeys>>, header: Uint8Array, plaintext: Uint8Array) => {
  const records: Array<Uint8Array> = []
  for (let counter = 0; counter * manifestRecordSize < plaintext.length; counter++) {
    records.push(
      await sealRecord(
        keys.manifest,
        header,
        { counter, isFinal: false },
        plaintext.subarray(counter * manifestRecordSize, (counter + 1) * manifestRecordSize),
      ),
    )
  }
  return records
}

const manifestStreamOf = (json: Uint8Array, records: number) => {
  const plaintext = new Uint8Array(records * manifestRecordSize)
  new DataView(plaintext.buffer).setUint32(0, json.length)
  plaintext.set(json, 4)
  return plaintext
}

export const generateRejections = async () => {
  const base = await sealParcel(singleFile(100), 12)
  const header = base.encryptor.header.bytes
  const keys = await deriveParcelKeys(secret, salt)
  const whole = (manifestRecords: ReadonlyArray<Uint8Array>, dataRecords: ReadonlyArray<Uint8Array> = base.dataRecords, trailer: Uint8Array = base.trailer) =>
    concatBytes(header, ...manifestRecords, ...dataRecords, trailer)
  const honest = whole(base.manifestRecords)
  const validJson = textEncoder.encode('{"version":1,"files":[{"name":"vector.bin","size":100,"mediaType":"application/octet-stream"}],"totalSize":100}')

  const dirtyPadding = manifestStreamOf(validJson, 1)
  dirtyPadding[manifestRecordSize - 1] = 1
  const forgedPrefix = await (async () => {
    // A data record with a valid tag under a nonce that is not the synthetic value of its plaintext.
    const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"])
    const aeadKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: textEncoder.encode(derivationSalt), info: concatBytes(textEncoder.encode(derivationInfo.contentKey), salt) },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    )
    const prefix = new Uint8Array(7).fill(0x42)
    const position = new Uint8Array(9)
    position[8] = 1
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: recordNonce(0, prefix), additionalData: concatBytes(header, position), tagLength: 128 },
      aeadKey,
      Uint8Array.from({ length: 100 }, (_, index) => plaintextByte(index)),
    )
    return concatBytes(prefix, new Uint8Array(sealed))
  })()
  const otherSecret = new Uint8Array(32).fill(0xee)

  const parcels: Array<{ name: string; secret: string; parcel: string; reason: string }> = [
    { name: "wrong secret", secret: toHex(otherSecret), parcel: toHex(honest), reason: "key-commitment-mismatch" },
    { name: "header only, wrong secret", secret: toHex(otherSecret), parcel: toHex(honest.subarray(0, headerLength)), reason: "key-commitment-mismatch" },
    { name: "cut before the trailer", secret: toHex(secret), parcel: toHex(honest.subarray(0, honest.length - base.trailer.length)), reason: "truncated" },
    { name: "a byte after the trailer", secret: toHex(secret), parcel: toHex(concatBytes(honest, new Uint8Array([0]))), reason: "trailing-data" },
    {
      name: "flipped synthetic prefix",
      secret: toHex(secret),
      parcel: toHex(honest.map((byte, index) => (index === headerLength ? byte ^ 1 : byte))),
      reason: "authentication-failed",
    },
    { name: "nonce that is not synthetic", secret: toHex(secret), parcel: toHex(whole(base.manifestRecords, [forgedPrefix])), reason: "authentication-failed" },
    {
      name: "non-zero manifest padding",
      secret: toHex(secret),
      parcel: toHex(whole(await sealManifestStream(keys, header, dirtyPadding))),
      reason: "invalid-manifest",
    },
    {
      name: "manifest stream longer than the minimal power of two",
      secret: toHex(secret),
      parcel: toHex(whole(await sealManifestStream(keys, header, manifestStreamOf(validJson, 2)))),
      // The receiver takes m from the announced length, so it reads the extra manifest record as data record 0.
      reason: "authentication-failed",
    },
    {
      name: "manifest not in canonical form",
      secret: toHex(secret),
      parcel: toHex(
        whole(await sealManifestStream(keys, header, manifestStreamOf(textEncoder.encode(new TextDecoder().decode(validJson).replace(",", ", ")), 1))),
      ),
      reason: "invalid-manifest",
    },
  ]

  return {
    description:
      "Parcel v1 rejection vectors (docs/parcel.md). Every receiver must reject each manifest JSON (hex bytes) and each parcel with the given reason. Parcels use the vectors' salt.",
    manifests: manifestRejections.map(([name, text]) => ({ name, json: toHex(textEncoder.encode(text)), reason: "invalid-manifest" })),
    parcels,
  }
}

if (import.meta.main) {
  const which = process.argv[2]
  if (which === "vectors") console.log(JSON.stringify(await generateVectors(), null, 2))
  else if (which === "rejections") console.log(JSON.stringify(await generateRejections(), null, 2))
  else throw new Error("usage: generate.ts vectors|rejections")
}
