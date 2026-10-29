/**
 * The in-browser half of the crypto benchmark (benchmark.ts, docs/spikes/0004-transfer-benchmarks.md): bundled with
 * Bun and run in each browser on a blank page. For each record size it measures, per byte, what a transfer does to
 * every record and what it would do without encryption:
 *   copy   a plain copy, the floor;
 *   label  SHA-256 of the record (the parcel's label; integrity and resume need it with or without encryption);
 *   seal   the record sealed (HMAC-SHA-256 for the synthetic nonce, then AES-256-GCM);
 *   open   the record opened (AES-256-GCM, then the synthetic nonce checked).
 * Records are processed one at a time, as the app does, so small records also pay the per-call cost of Web Crypto.
 */
import { deriveParcelKeys, deriveParcelSecret, encodeHeader, leafHash, openRecord, sealRecord } from "@file-transfer/parcel"

export interface CryptoRow {
  readonly recordSizeExponent: number
  readonly recordBytes: number
  readonly copy: number
  readonly label: number
  readonly seal: number
  readonly open: number
}

declare global {
  interface Window {
    runCryptoBenchmark?: (exponents: readonly number[], bytesPerMeasurement: number) => Promise<readonly CryptoRow[]>
  }
}

const position = (index: number) => ({ counter: index, isFinal: false })

/** Megabytes per second for `bytes` in `milliseconds`. */
const rate = (bytes: number, milliseconds: number): number => Math.round((bytes / 1e6 / (milliseconds / 1000)) * 10) / 10

const time = async (count: number, step: (index: number) => Promise<void> | void): Promise<number> => {
  const started = performance.now()

  for (let index = 0; index < count; index++) {
    await step(index)
  }

  return performance.now() - started
}

window.runCryptoBenchmark = async (exponents, bytesPerMeasurement) => {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const keys = await deriveParcelKeys(await deriveParcelSecret(crypto.getRandomValues(new Uint8Array(32)), 0), salt)
  const rows: CryptoRow[] = []

  for (const exponent of exponents) {
    const size = 2 ** exponent
    const count = Math.max(4, Math.floor(bytesPerMeasurement / size))
    const bytes = count * size
    const header = encodeHeader({ recordSizeExponent: exponent, sequence: 0, salt, keyCommitment: keys.keyCommitment })
    // getRandomValues fills at most 65,536 bytes at a time.
    const plaintext = new Uint8Array(size)

    for (let offset = 0; offset < size; offset += 65_536) {
      crypto.getRandomValues(plaintext.subarray(offset, Math.min(size, offset + 65_536)))
    }

    const sealed = await sealRecord(keys.content, header.bytes, position(0), plaintext)
    const target = new Uint8Array(size)

    // One warm-up record each, so the first measurement does not pay for compiling the code paths.
    await leafHash(plaintext)
    await openRecord(keys.content, header.bytes, position(0), sealed, "record")

    const copyMilliseconds = await time(count, () => {
      target.set(plaintext)
    })

    const labelMilliseconds = await time(count, async () => {
      await leafHash(plaintext)
    })

    const sealMilliseconds = await time(count, async (index) => {
      await sealRecord(keys.content, header.bytes, position(index), plaintext)
    })

    const records = await Promise.all(
      Array.from({ length: Math.min(count, 8) }, async (_, index) => await sealRecord(keys.content, header.bytes, position(index), plaintext)),
    )

    const openMilliseconds = await time(count, async (index) => {
      await openRecord(keys.content, header.bytes, position(index % records.length), records[index % records.length] ?? sealed, "record")
    })

    rows.push({
      recordSizeExponent: exponent,
      recordBytes: size,
      copy: rate(bytes, copyMilliseconds),
      label: rate(bytes, labelMilliseconds),
      seal: rate(bytes, sealMilliseconds),
      open: rate(bytes, openMilliseconds),
    })
  }

  return rows
}
