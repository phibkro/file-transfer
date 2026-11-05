import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { deriveMyFiles } from "@file-transfer/catalog"
import type { IndexedVersion, LibrarySnapshot } from "@file-transfer/catalog"
import { indexCatalogFiles, inspectCatalogSource, reviewCatalogFiles } from "../src/capabilities/catalog/browser.ts"

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
const readableHandle = (getFile: () => Promise<File>, permission: PermissionState = "granted") =>
  ({
    kind: "file",
    name: "fixture",
    getFile,
    requestPermission: async () => permission,
    isSameEntry: async () => false,
    createWritable: async () => {
      throw new DOMException("Read-only fixture", "NotAllowedError")
    },
  }) satisfies FileSystemFileHandle

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

  it("fingerprints changed bytes even when name, size and modification time are identical", async () => {
    const options = { lastModified: 123 }
    const original = first(await inspect([new File(["first"], "same.txt", options)]))
    const replacement = first(await inspect([new File(["other"], "same.txt", options)]))
    expect(replacement).toMatchObject({ name: "same.txt", size: 5, lastModified: 123 })
    expect(replacement.fingerprint).not.toBe(original.fingerprint)
  })

  it("does not include the file name or modification time in the content fingerprint", async () => {
    const original = first(await inspect([new File(["same bytes"], "old.txt", { lastModified: 1 })]))
    const renamed = first(await inspect([new File(["same bytes"], "new.txt", { lastModified: 2 })]))
    expect(renamed).toMatchObject({ name: "new.txt", size: 10, lastModified: 2 })
    expect(renamed.fingerprint).toBe(original.fingerprint)
  })

  it("does not read candidate bytes when indexing is constructed and discarded", () => {
    let reads = 0

    class ObservedFile extends File {
      override slice(start?: number, end?: number, contentType?: string): Blob {
        reads++

        return super.slice(start, end, contentType)
      }
    }

    const indexing = indexCatalogFiles([new ObservedFile(["private"], "private.txt", { lastModified: 1 })])
    expect(indexing).toBeDefined()
    expect(reads).toBe(0)
  })

  it("preserves a foreign candidate read failure", async () => {
    const cause = new DOMException("The selected file is no longer readable", "NotReadableError")

    class UnreadableFile extends File {
      readonly failure = cause

      override slice(): Blob {
        throw this.failure
      }
    }

    const error = await Effect.runPromise(Effect.flip(indexCatalogFiles([new UnreadableFile(["private"], "private.txt", { lastModified: 1 })])))
    expect(error._tag).toBe("LibraryStorageError")
    expect(error.cause).toBe(cause)
  })

  it("requires reselection after reload leaves metadata without a handle or File", async () => {
    const error = await Effect.runPromise(
      Effect.flip(reviewCatalogFiles([storedFile({ name: "missing.txt", size: 3, lastModified: 1, fingerprint: "v1:fixture" })])),
    )

    expect(error._tag).toBe("LibraryStorageError")
    expect(error.cause).toBeInstanceOf(DOMException)
    expect(error.cause).toMatchObject({ name: "NotFoundError" })
  })

  it("reviews an empty selection without acquiring source capabilities", async () => {
    expect(await Effect.runPromise(reviewCatalogFiles([]))).toEqual([])
  })

  it("does not resolve a missing source when review is constructed and discarded", () => {
    const review = reviewCatalogFiles([storedFile({ name: "empty", size: 0, lastModified: 0, fingerprint: "v1:fixture" })])
    expect(review).toBeDefined()
  })
})

describe("local Library browser source inspection", () => {
  it("returns the actual captured File without claiming to observe later filesystem edits", async () => {
    const file = new File(["snapshot"], "draft.txt", { lastModified: 5 })
    const indexed = first(await inspect([file]))
    const inspected = await Effect.runPromise(inspectCatalogSource({ file }))
    expect(inspected.file).toBe(file)
    expect(inspected.current).toMatchObject({ name: "draft.txt", size: 8, lastModified: 5, fingerprint: indexed.fingerprint })
    expect(inspected.current.file).toBe(file)
    expect(inspected.current.handle).toBeUndefined()
  })

  it("rechecks durable handles instead of using an older captured File", async () => {
    const stale = new File(["old"], "old.txt", { lastModified: 1 })
    const current = new File(["newer"], "new.txt", { lastModified: 2 })
    let reads = 0
    const permissions: { mode: "read" }[] = []

    const handle: FileSystemFileHandle = {
      ...readableHandle(async () => {
        reads++

        return current
      }),
      requestPermission: async (options) => {
        permissions.push(options)

        return "granted"
      },
    }

    const inspected = await Effect.runPromise(inspectCatalogSource({ file: stale, handle }))
    expect(permissions).toEqual([{ mode: "read" }])
    expect(reads).toBe(1)
    expect(inspected.current).toMatchObject({ name: "new.txt", size: 5, lastModified: 2, handle })
    expect(inspected.file).toBe(current)
  })

  it("fingerprints the newly read durable bytes even when metadata is unchanged", async () => {
    const original = new File(["first"], "same.txt", { lastModified: 123 })
    const originalVersion = first(await inspect([original]))
    const replacement = new File(["other"], "same.txt", { lastModified: 123 })
    const inspected = await Effect.runPromise(inspectCatalogSource({ file: original, handle: readableHandle(async () => replacement) }))
    expect(inspected.current).toMatchObject({ name: "same.txt", size: 5, lastModified: 123 })
    expect(inspected.current.fingerprint).not.toBe(originalVersion.fingerprint)
    expect(inspected.file).toBe(replacement)
  })

  it.each(["denied", "prompt"] as const)("does not read or substitute a captured File when durable permission is %s", async (permission) => {
    let reads = 0
    const file = new File(["private"], "private.txt", { lastModified: 1 })

    const handle = readableHandle(async () => {
      reads++

      return new File(["must not read"], "private.txt", { lastModified: 1 })
    }, permission)

    const error = await Effect.runPromise(Effect.flip(inspectCatalogSource({ file, handle })))
    expect(reads).toBe(0)
    expect(error._tag).toBe("LibraryStorageError")
    expect(error.cause).toBeInstanceOf(DOMException)
    expect(error.cause).toMatchObject({ name: "NotAllowedError" })
  })

  it("preserves foreign read failures instead of silently returning a stale snapshot", async () => {
    const file = new File(["old"], "draft.txt", { lastModified: 1 })
    const cause = new DOMException("The original file was removed", "NotFoundError")

    const handle = readableHandle(async () => {
      throw cause
    })

    const error = await Effect.runPromise(Effect.flip(inspectCatalogSource({ file, handle })))
    expect(error._tag).toBe("LibraryStorageError")
    expect(error.cause).toBe(cause)
  })

  it("preserves permission request failures without reading a durable handle", async () => {
    let reads = 0
    const cause = new DOMException("Permission request failed", "SecurityError")

    const handle: FileSystemFileHandle = {
      ...readableHandle(async () => {
        reads++

        return new File([], "empty", { lastModified: 0 })
      }),
      requestPermission: async () => {
        throw cause
      },
    }

    const error = await Effect.runPromise(Effect.flip(inspectCatalogSource({ handle })))
    expect(reads).toBe(0)
    expect(error._tag).toBe("LibraryStorageError")
    expect(error.cause).toBe(cause)
  })

  it("requires reselection when neither a durable handle nor a captured File exists", async () => {
    const error = await Effect.runPromise(Effect.flip(inspectCatalogSource({})))
    expect(error._tag).toBe("LibraryStorageError")
    expect(error.cause).toMatchObject({ name: "NotFoundError" })
  })

  it("does not acquire bytes or permissions when source inspection is constructed and discarded", () => {
    let reads = 0
    let permissions = 0

    const handle: FileSystemFileHandle = {
      ...readableHandle(async () => {
        reads++

        return new File([], "empty", { lastModified: 0 })
      }),
      requestPermission: async () => {
        permissions++

        return "granted"
      },
    }

    const inspection = inspectCatalogSource({ handle })
    expect(inspection).toBeDefined()
    expect(reads).toBe(0)
    expect(permissions).toBe(0)
  })
})
