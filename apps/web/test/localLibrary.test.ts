import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { deriveMyFiles, indexCatalogFiles, reviewCatalogFiles } from "../src/localLibrary.ts"
import type { IndexedVersion, LibrarySnapshot } from "../src/localLibrary.ts"

const storedFile = (entry: IndexedVersion, identifier = 1) => ({ ...entry, identifier, revision: 3 })

const snapshot = (files: LibrarySnapshot["files"]): LibrarySnapshot => ({
  enabled: true,
  epoch: 7,
  files,
  collections: [{ identifier: 9, revision: 0, name: "Selected", fileIdentifiers: [] }],
})

const first = <A>(values: readonly A[]): A => {
  const value = values[0]

  if (value === undefined) {
    throw new Error("Expected one test fixture")
  }

  return value
}

// A foreign handle fixture exposes the full ABI without claiming decoded data.
const readableHandle = (getFile: () => Promise<File>, permission: PermissionState = "granted"): FileSystemFileHandle => ({
  kind: "file",
  name: "fixture",
  getFile,
  requestPermission: async () => permission,
  isSameEntry: async () => false,
  createWritable: async () => {
    throw new DOMException("Read-only fixture", "NotAllowedError")
  },
})

const inspect = async (files: readonly File[]) => await Effect.runPromise(indexCatalogFiles(files))

describe("local Library derived My files", () => {
  it("derives every indexed identifier independently of saved membership", () => {
    const entry = { name: "local.txt", size: 0, lastModified: 1, fingerprint: "v1:fixture" }
    const before = snapshot([storedFile(entry, 2), storedFile(entry, 8)])
    expect(deriveMyFiles(before).fileIdentifiers).toEqual([2, 8])
    expect(deriveMyFiles({ ...before, files: [storedFile(entry, 8)] }).fileIdentifiers).toEqual([8])
    expect(before.collections[0]?.fileIdentifiers).toEqual([])
    expect(before.files).toHaveLength(2)
  })
})

describe("local Library file capabilities", () => {
  it("indexes an empty selection without acquiring a browser picker", async () => {
    expect(await inspect([])).toEqual([])
  })

  it("retains a transient File with metadata but does not invent a durable handle", async () => {
    const file = new File(["hello"], "notes.txt", { lastModified: 42 })
    const entry = first(await inspect([file]))
    expect(entry).toMatchObject({ name: "notes.txt", size: 5, lastModified: 42 })
    expect(entry.file).toBe(file)
    expect(entry.handle).toBeUndefined()
    expect(entry.fingerprint).toMatch(/^v1:[0-9a-f]{64}$/u)
  })

  it("keeps the v1 empty-file fingerprint compatible", async () => {
    const entry = first(await inspect([new File([], "empty", { lastModified: 1 })]))
    expect(entry.fingerprint).toBe("v1:6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d")
  })

  it("detects changed bytes even when name, size and modification time are identical", async () => {
    const options = { lastModified: 123 }
    const original = first(await inspect([new File(["first"], "same.txt", options)]))
    const replacement = new File(["other"], "same.txt", options)
    const handle = readableHandle(async () => replacement)
    const reviewed = first(await Effect.runPromise(reviewCatalogFiles([storedFile({ ...original, handle })])))
    expect(reviewed.changed).toBe(true)
    expect(reviewed.current.fingerprint).not.toBe(original.fingerprint)
    expect(reviewed.file).toBe(replacement)
  })

  it("rechecks durable handles instead of using an older captured File", async () => {
    const original = first(await inspect([new File(["old"], "old.txt", { lastModified: 1 })]))
    const current = new File(["newer"], "new.txt", { lastModified: 2 })
    let reads = 0

    const handle = readableHandle(async () => {
      reads++

      return current
    })

    const reviewed = first(await Effect.runPromise(reviewCatalogFiles([storedFile({ ...original, handle })])))
    expect(reads).toBe(1)
    expect(reviewed.changed).toBe(true)
    expect(reviewed.current).toMatchObject({ name: "new.txt", size: 5, lastModified: 2, handle })
    expect(reviewed.file).toBe(current)
  })

  it("reviews a captured snapshot without claiming it observes later filesystem edits", async () => {
    const file = new File(["snapshot"], "draft.txt", { lastModified: 5 })
    const entry = first(await inspect([file]))
    const previous = storedFile(entry)
    const reviewed = first(await Effect.runPromise(reviewCatalogFiles([previous])))
    expect(reviewed.changed).toBe(false)
    expect(reviewed.previous).toBe(previous)
    expect(reviewed.file).toBe(file)
    expect(reviewed.current.file).toBe(file)
    expect(reviewed.current.handle).toBeUndefined()
  })

  it("requires reselection after reload leaves metadata without a handle or File", async () => {
    const error = await Effect.runPromise(
      Effect.flip(reviewCatalogFiles([storedFile({ name: "missing.txt", size: 3, lastModified: 1, fingerprint: "v1:fixture" })])),
    )

    expect(error._tag).toBe("LibraryStorageError")
    expect(error.cause).toBeInstanceOf(DOMException)
    expect(error.cause).toMatchObject({ name: "NotFoundError" })
  })

  it("reviews a reselected File against the old fingerprint and preserves the reviewed revision", async () => {
    const original = first(await inspect([new File(["before"], "draft.txt", { lastModified: 1 })]))
    const reselectedFile = new File(["after!"], "draft.txt", { lastModified: 1 })
    const reselected = first(await inspect([reselectedFile]))
    const previous = storedFile({ ...original, file: reselectedFile })
    const reviewed = first(await Effect.runPromise(reviewCatalogFiles([previous])))
    expect(reviewed.changed).toBe(true)
    expect(reviewed.previous.identifier).toBe(1)
    expect(reviewed.previous.revision).toBe(3)
    expect(reviewed.current.fingerprint).toBe(reselected.fingerprint)
  })

  it("does not read or substitute a captured File when durable permission is denied", async () => {
    const original = first(await inspect([new File(["private"], "private.txt", { lastModified: 1 })]))
    let reads = 0

    const handle = readableHandle(async () => {
      reads++

      return new File(["must not read"], "private.txt")
    }, "denied")

    const error = await Effect.runPromise(Effect.flip(reviewCatalogFiles([storedFile({ ...original, handle })])))
    expect(reads).toBe(0)
    expect(error._tag).toBe("LibraryStorageError")
    expect(error.cause).toMatchObject({ name: "NotAllowedError" })
  })

  it("preserves foreign read failures instead of silently sharing a stale snapshot", async () => {
    const original = first(await inspect([new File(["old"], "draft.txt", { lastModified: 1 })]))
    const cause = new DOMException("The original file was removed", "NotFoundError")

    const handle = readableHandle(async () => {
      throw cause
    })

    const error = await Effect.runPromise(Effect.flip(reviewCatalogFiles([storedFile({ ...original, handle })])))
    expect(error._tag).toBe("LibraryStorageError")
    expect(error.cause).toBe(cause)
  })

  it("does not acquire file bytes or permissions when review is constructed and discarded", () => {
    let reads = 0

    const handle = readableHandle(async () => {
      reads++

      return new File([], "empty")
    })

    const review = reviewCatalogFiles([storedFile({ name: "empty", size: 0, lastModified: 0, fingerprint: "v1:fixture", handle })])
    expect(review).toBeDefined()
    expect(reads).toBe(0)
  })
})
