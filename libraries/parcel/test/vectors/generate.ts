/**
 * Prints the parcel v1 test vectors as JSON:
 *   bun libraries/parcel/test/vectors/generate.ts vectors > libraries/parcel/test/vectors/vectors.json
 *   bun libraries/parcel/test/vectors/generate.ts rejections > libraries/parcel/test/vectors/rejections.json
 * Inputs are fixed; `vectors.test.ts` regenerates and compares, and `verify.py` reproduces every positive byte and
 * rejects every negative case independently.
 */
import {
  concatBytes,
  createManifest,
  createParcelSealer,
  derivationInfo,
  derivationSalt,
  deriveParcelKeys,
  deriveParcelSecret,
  deriveRoomToken,
  encodeManifestJson,
  encodeManifestStream,
  hashRoomToken,
  headerLength,
  labelRecords,
  leafHash,
  manifestRecordSize,
  recordNonce,
  recordReaderFromBytes,
  sealRecord,
  toHex,
} from "../../src/index.ts"
import type { Manifest } from "../../src/index.ts"

export const secret = Uint8Array.from({ length: 32 }, (_, index) => index)
export const salt = Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index)
export const plaintextByte = (index: number) => index % 251

const textEncoder = new TextEncoder()

const expandHex = async (ikm: Uint8Array, label: string, suffix: Uint8Array) => {
  const material = await crypto.subtle.importKey("raw", new Uint8Array(ikm), "HKDF", false, ["deriveBits"])
  const info = concatBytes(textEncoder.encode(label), suffix)

  return toHex(new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: textEncoder.encode(derivationSalt), info }, material, 256)))
}

const keysHex = async (parcelSecret: Uint8Array) => ({
  contentKey: await expandHex(parcelSecret, derivationInfo.contentKey, salt),
  contentSyntheticKey: await expandHex(parcelSecret, derivationInfo.contentSyntheticKey, salt),
  manifestKey: await expandHex(parcelSecret, derivationInfo.manifestKey, salt),
  manifestSyntheticKey: await expandHex(parcelSecret, derivationInfo.manifestSyntheticKey, salt),
  keyCommitment: await expandHex(parcelSecret, derivationInfo.keyCommitment, salt),
})

const plaintextOf = (manifest: Manifest, change?: number) =>
  Uint8Array.from({ length: manifest.totalSize }, (_, index) => (index === change ? plaintextByte(index) ^ 0xff : plaintextByte(index)))

const sealParcel = async (manifest: Manifest, recordSizeExponent: number, sequence = 0) => {
  const size = 2 ** recordSizeExponent
  const plaintext = plaintextOf(manifest)
  const sealer = await createParcelSealer({ linkSecret: secret, sequence, salt, manifest, recordSizeExponent })
  const labels = await labelRecords(sealer, recordReaderFromBytes(plaintext, size))
  const contract = await sealer.sealContract(labels)
  const dataRecords: Uint8Array[] = []

  for (let index = 0; index < sealer.recordCount; index++) {
    dataRecords.push(await sealer.sealData(index, plaintext.subarray(index * size, index * size + sealer.dataPlaintextLength(index))))
  }

  const labelPages = await Promise.all(Array.from({ length: contract.pageCount }, async (_, page) => await contract.labelPage(page)))

  return { sealer, labels, contract, dataRecords, labelPages }
}

const vectorCase = async (name: string, recordSizeExponent: number, manifest: Manifest, options: { sequence?: number; recordsAsLabelsOnly?: boolean } = {}) => {
  const sequence = options.sequence ?? 0
  const sealed = await sealParcel(manifest, recordSizeExponent, sequence)

  return {
    name,
    recordSizeExponent,
    sequence,
    manifest,
    manifestJson: new TextDecoder().decode(encodeManifestJson(manifest)),
    recordCount: sealed.sealer.recordCount,
    header: toHex(sealed.contract.header.bytes),
    manifestRecords: sealed.contract.manifestRecords.map(toHex),
    labels: Array.from({ length: sealed.sealer.recordCount }, (_, index) => toHex(sealed.contract.labelOf(index))),
    rootHash: toHex(sealed.contract.rootHash),
    contractDigest: toHex(sealed.contract.digest),
    labelPages: sealed.labelPages.map(toHex),
    ...(options.recordsAsLabelsOnly === true ? {} : { dataRecords: sealed.dataRecords.map(toHex) }),
  }
}

const singleFile = (size: number) => createManifest([{ name: "vector.bin", size, mediaType: "application/octet-stream" }])

export const generateVectors = async () => {
  const roomToken = await deriveRoomToken(secret)
  const parcelSecret = await deriveParcelSecret(secret, 0)
  const parcelSecretSeven = await deriveParcelSecret(secret, 7)

  return {
    description:
      "Parcel v1 test vectors (docs/parcel.md). Plaintext byte i is i mod 251, files concatenated in manifest order. Keys are for sequence 0 with the given salt; the multi-page case lists labels instead of data records.",
    linkSecret: toHex(secret),
    linkFragment: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    salt: toHex(salt),
    roomToken: toHex(roomToken),
    roomTokenHash: await hashRoomToken(roomToken),
    parcelSecrets: { "0": toHex(parcelSecret), "7": toHex(parcelSecretSeven) },
    keys: await keysHex(parcelSecret),
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
      await vectorCase("sequence 7", 12, singleFile(100), { sequence: 7 }),
      await vectorCase("two label pages", 12, singleFile(1024 * 4096 + 1), { recordsAsLabelsOnly: true }),
    ],
  }
}

/** Raw canonical-JSON candidates every receiver must reject, as bytes, with the reason. */
const manifestRejections: readonly (readonly [string, string])[] = [
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
  // Assigned in Unicode 16.0 (ARABIC PEPET, a combining mark): unassigned in 15.1, so rejected before NFC is checked.
  ["code point unassigned in Unicode 15.1", '{"version":1,"files":[{"name":"pepet\u0897","size":1,"mediaType":""}],"totalSize":1}'],
  ["noncharacter", '{"version":1,"files":[{"name":"a\uFDD0","size":1,"mediaType":""}],"totalSize":1}'],
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

export const generateRejections = async () => {
  const manifest = singleFile(100)
  const base = await sealParcel(manifest, 12)
  const header = base.contract.header.bytes
  const keys = await deriveParcelKeys(await deriveParcelSecret(secret, 0), salt)
  const label = base.contract.labelOf(0)
  const honest = concatBytes(header, ...base.contract.manifestRecords, ...base.labelPages, ...base.dataRecords)
  const validJson = encodeManifestJson(manifest)

  /** A manifest stream with chosen terms, JSON bytes, record count and padding, sealed under the vectors' keys. */
  const manifestRecordsOf = async (
    options: { recordCount?: number; json?: Uint8Array; records?: number; dirtyPadding?: boolean; labels?: Uint8Array } = {},
  ) => {
    const json = options.json ?? validJson
    const template = encodeManifestStream(manifest, { recordCount: options.recordCount ?? 1, rootHash: options.labels ?? label })
    const plaintext = new Uint8Array((options.records ?? 1) * manifestRecordSize)
    plaintext.set(template.subarray(0, 40), 0)
    new DataView(plaintext.buffer).setUint32(40, json.length)
    plaintext.set(json, 44)

    if (options.dirtyPadding === true) {
      plaintext[plaintext.length - 1] = 1
    }

    const records: Uint8Array[] = []

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

  // A data record with a valid tag under a nonce that is not the synthetic value of its plaintext, and a contract whose label matches it.
  const forged = await (async () => {
    const prefix = new Uint8Array(7).fill(0x42)
    const position = new Uint8Array(9)
    position[8] = 1

    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: recordNonce(0, prefix), additionalData: concatBytes(header, position), tagLength: 128 },
      keys.content.aeadKey,
      plaintextOf(manifest),
    )

    return concatBytes(prefix, new Uint8Array(sealed))
  })()

  const forgedLabel = await leafHash(forged)
  const breached = await base.sealer.sealData(0, plaintextOf(manifest, 50))
  const tamperedPage = base.labelPages[0]?.slice() ?? new Uint8Array(32)
  tamperedPage[0] = (tamperedPage[0] ?? 0) ^ 1

  // The second review's S1: after a reload the sender relabels a file that changed, under the same sequence number
  // and salt. The header is byte-identical, the contract is not; only a receiver that pinned the digest rejects it.
  const relabelled = await (async () => {
    const sealer = await createParcelSealer({ linkSecret: secret, sequence: 0, salt, manifest, recordSizeExponent: 12 })
    const changed = plaintextOf(manifest, 50)
    const contract = await sealer.sealContract(await labelRecords(sealer, recordReaderFromBytes(changed, 4096)))

    return concatBytes(contract.header.bytes, ...contract.manifestRecords, await contract.labelPage(0), await sealer.sealData(0, changed))
  })()

  const otherSecret = new Uint8Array(32).fill(0xee)

  const wire = (manifestRecords: readonly Uint8Array[], page: Uint8Array, record: Uint8Array) => toHex(concatBytes(header, ...manifestRecords, page, record))

  const parcels: { name: string; secret: string; parcel: string; reason: string; expectedDigest?: string }[] = [
    { name: "wrong secret", secret: toHex(otherSecret), parcel: toHex(honest), reason: "key-commitment-mismatch" },
    { name: "header only, wrong secret", secret: toHex(otherSecret), parcel: toHex(honest.subarray(0, headerLength)), reason: "key-commitment-mismatch" },
    { name: "cut inside the last record", secret: toHex(secret), parcel: toHex(honest.subarray(0, -1)), reason: "truncated" },
    { name: "a byte after the last record", secret: toHex(secret), parcel: toHex(concatBytes(honest, new Uint8Array([0]))), reason: "trailing-data" },
    {
      name: "another contract under a header that is byte-identical to the pinned one",
      secret: toHex(secret),
      parcel: toHex(relabelled),
      expectedDigest: toHex(base.contract.digest),
      reason: "contract-mismatch",
    },
    {
      name: "flipped synthetic prefix of manifest record 0",
      secret: toHex(secret),
      parcel: toHex(honest.map((byte, index) => (index === headerLength ? byte ^ 1 : byte))),
      reason: "authentication-failed",
    },
    {
      name: "nonce that is not synthetic, with a matching label",
      secret: toHex(secret),
      parcel: wire(await manifestRecordsOf({ labels: forgedLabel }), forgedLabel, forged),
      reason: "authentication-failed",
    },
    {
      name: "non-zero manifest padding",
      secret: toHex(secret),
      parcel: wire(await manifestRecordsOf({ dirtyPadding: true }), label, base.dataRecords[0] ?? label),
      reason: "invalid-manifest",
    },
    {
      name: "manifest not in canonical form",
      secret: toHex(secret),
      parcel: wire(
        await manifestRecordsOf({ json: textEncoder.encode(new TextDecoder().decode(validJson).replace(",", ", ")) }),
        label,
        base.dataRecords[0] ?? label,
      ),
      reason: "invalid-manifest",
    },
    {
      name: "manifest stream longer than the minimal power of two",
      secret: toHex(secret),
      // The receiver takes m from the announced length, so the extra record's first bytes are read as label page 0.
      parcel: wire(await manifestRecordsOf({ records: 2 }), label, base.dataRecords[0] ?? label),
      reason: "label-page-mismatch",
    },
    {
      name: "contract record count that does not match the manifest",
      secret: toHex(secret),
      parcel: wire(await manifestRecordsOf({ recordCount: 2 }), label, base.dataRecords[0] ?? label),
      reason: "record-count-mismatch",
    },
    {
      name: "label page that does not belong to the root",
      secret: toHex(secret),
      parcel: wire(base.contract.manifestRecords, tamperedPage, base.dataRecords[0] ?? label),
      reason: "label-page-mismatch",
    },
    {
      name: "record that differs from its label (breach)",
      secret: toHex(secret),
      parcel: wire(base.contract.manifestRecords, label, breached),
      reason: "label-mismatch",
    },
  ]

  return {
    description:
      "Parcel v1 rejection vectors (docs/parcel.md). Every receiver must reject each manifest JSON (hex bytes) and each parcel with the given reason. Parcels use the vectors' link secret, sequence 0 and salt; a parcel with `expectedDigest` is received by a recipient that already pinned that contract digest for sequence 0.",
    manifests: manifestRejections.map(([name, text]) => ({ name, json: toHex(textEncoder.encode(text)), reason: "invalid-manifest" })),
    parcels,
  }
}

if (import.meta.main) {
  const which = process.argv[2]

  if (which === "vectors") {
    console.log(JSON.stringify(await generateVectors(), null, 2))
  } else if (which === "rejections") {
    console.log(JSON.stringify(await generateRejections(), null, 2))
  } else {
    throw new Error("usage: generate.ts vectors|rejections")
  }
}
