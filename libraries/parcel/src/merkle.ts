// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/**
 * RFC 6962 Merkle tree hash over ciphertext records (docs/parcel.md, "Trailer"). `MerkleFrontier` keeps one hash per
 * complete subtree (at most log2(n) of them), so the sender hashes while streaming and never holds the records.
 */
import { asBufferSource, concatBytes, fromHex, toHex } from "./bytes.ts"
import { ParcelError } from "./errors.ts"

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await crypto.subtle.digest("SHA-256", asBufferSource(bytes)))

const leafPrefix = new Uint8Array([0x00])
const nodePrefix = new Uint8Array([0x01])

export const leafHash = (leaf: Uint8Array) => sha256(concatBytes(leafPrefix, leaf))
export const nodeHash = (left: Uint8Array, right: Uint8Array) => sha256(concatBytes(nodePrefix, left, right))

/** The tree hash of a list of leaves, computed directly from the RFC 6962 definition. For tests and small inputs. */
export const merkleRoot = async (leaves: ReadonlyArray<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> => {
  if (leaves.length === 0) return sha256(new Uint8Array(0))
  if (leaves.length === 1) return leafHash(leaves[0] ?? new Uint8Array(0))
  let split = 1
  while (split * 2 < leaves.length) split *= 2
  return nodeHash(await merkleRoot(leaves.slice(0, split)), await merkleRoot(leaves.slice(split)))
}

interface Subtree {
  readonly size: number
  readonly hash: Uint8Array<ArrayBuffer>
}

/** A resumable snapshot: the complete subtrees from left to right, hex encoded. */
export type MerkleFrontierSnapshot = ReadonlyArray<{ readonly size: number; readonly hash: string }>

export class MerkleFrontier {
  #subtrees: Array<Subtree> = []

  get leafCount(): number {
    return this.#subtrees.reduce((sum, subtree) => sum + subtree.size, 0)
  }

  /** Appends a leaf by its leaf hash (see `leafHash`). Calls must not overlap. */
  async appendLeafHash(hash: Uint8Array): Promise<void> {
    let current: Subtree = { size: 1, hash: new Uint8Array(hash) }
    for (let last = this.#subtrees.at(-1); last !== undefined && last.size === current.size; last = this.#subtrees.at(-1)) {
      this.#subtrees.pop()
      current = { size: last.size * 2, hash: await nodeHash(last.hash, current.hash) }
    }
    this.#subtrees.push(current)
  }

  async append(leaf: Uint8Array): Promise<void> {
    await this.appendLeafHash(await leafHash(leaf))
  }

  /** The tree hash of every leaf appended so far. */
  async root(): Promise<Uint8Array<ArrayBuffer>> {
    const last = this.#subtrees.at(-1)
    if (last === undefined) return sha256(new Uint8Array(0))
    let accumulated = last.hash
    for (let index = this.#subtrees.length - 2; index >= 0; index--) {
      accumulated = await nodeHash(this.#subtrees[index]?.hash ?? new Uint8Array(0), accumulated)
    }
    return accumulated
  }

  snapshot(): MerkleFrontierSnapshot {
    return this.#subtrees.map(({ size, hash }) => ({ size, hash: toHex(hash) }))
  }

  static restore(snapshot: MerkleFrontierSnapshot): MerkleFrontier {
    const valid = snapshot.every(
      ({ size, hash }, index) =>
        Number.isSafeInteger(size) &&
        size > 0 &&
        Number.isInteger(Math.log2(size)) &&
        hash.length === 64 &&
        (index === 0 || size < (snapshot[index - 1]?.size ?? 0)),
    )
    if (!valid) throw new ParcelError("invalid-argument", "not a Merkle frontier snapshot")
    const frontier = new MerkleFrontier()
    frontier.#subtrees = snapshot.map(({ size, hash }) => ({ size, hash: fromHex(hash) }))
    return frontier
  }
}
