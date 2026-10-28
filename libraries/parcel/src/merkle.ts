// oxlint-effect-plugin ignore-file:
// reason: the parcel library is MIT and deliberately free of Effect so other clients can adopt it; Web Crypto is its one capability and callers wrap it (docs/decisions/0009)
/**
 * RFC 6962 Merkle trees over data record labels (docs/parcel.md, "Labels and the root" and "Label pages").
 *
 * A label is a leaf hash. Trees here are computed over nodes that are already hashed (labels, or page roots), so
 * only interior nodes are hashed. Because a page holds a power of two of labels, every page is a node of the tree
 * over all labels, and the root over page roots equals the root over all labels.
 */
import { asBufferSource, concatBytes } from "./bytes.ts"
import { ParcelError } from "./errors.ts"

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await crypto.subtle.digest("SHA-256", asBufferSource(bytes)))

const leafPrefix = new Uint8Array([0x00])
const nodePrefix = new Uint8Array([0x01])

/** A record's label: its RFC 6962 leaf hash. */
export const leafHash = (leaf: Uint8Array) => sha256(concatBytes(leafPrefix, leaf))
export const nodeHash = (left: Uint8Array, right: Uint8Array) => sha256(concatBytes(nodePrefix, left, right))

/** The largest power of two strictly below `size` (size at least 2). */
const splitOf = (size: number): number => {
  let split = 1

  while (split * 2 < size) {
    split *= 2
  }

  return split
}

/** The tree hash of a list of leaves, computed directly from the RFC 6962 definition. For tests and small inputs. */
export const merkleRoot = async (leaves: readonly Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> => {
  if (leaves.length === 0) {
    return sha256(new Uint8Array(0))
  }

  if (leaves.length === 1) {
    return leafHash(leaves[0] ?? new Uint8Array(0))
  }

  const split = splitOf(leaves.length)

  return nodeHash(await merkleRoot(leaves.slice(0, split)), await merkleRoot(leaves.slice(split)))
}

/** The tree hash over already-hashed nodes `start .. end - 1` (a single node is itself). */
export const treeHash = async (nodes: readonly Uint8Array[], start = 0, end = nodes.length): Promise<Uint8Array<ArrayBuffer>> => {
  if (end - start < 1) {
    throw new ParcelError("invalid-argument", "a tree needs at least one node")
  }

  if (end - start === 1) {
    return new Uint8Array(nodes[start] ?? new Uint8Array(32))
  }

  const split = splitOf(end - start)

  return nodeHash(await treeHash(nodes, start, start + split), await treeHash(nodes, start + split, end))
}

export interface Sibling {
  readonly side: "left" | "right"
  readonly start: number
  readonly end: number
}

/** The audit path of node `index` among `count` nodes: sibling ranges, nearest first (docs/parcel.md, "Label pages"). */
export const auditPath = (count: number, index: number): readonly Sibling[] => {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new ParcelError("invalid-argument", "node index out of range")
  }

  const path: Sibling[] = []

  const walk = (start: number, end: number) => {
    if (end - start === 1) {
      return
    }

    const split = start + splitOf(end - start)

    if (index < split) {
      walk(start, split)
      path.push({ side: "right", start: split, end })
    } else {
      walk(split, end)
      path.push({ side: "left", start, end: split })
    }
  }

  walk(0, count)

  return path
}

/** Folds a node with its audit path's sibling hashes into the root. */
export const foldAuditPath = async (node: Uint8Array, path: readonly Sibling[], siblingHashes: readonly Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> => {
  if (path.length !== siblingHashes.length) {
    throw new ParcelError("invalid-argument", "one hash per sibling")
  }

  let accumulated = new Uint8Array(node)

  for (const [index, sibling] of path.entries()) {
    const hash = siblingHashes[index] ?? new Uint8Array(32)
    accumulated = sibling.side === "right" ? await nodeHash(accumulated, hash) : await nodeHash(hash, accumulated)
  }

  return accumulated
}
