import { describe, expect, it } from "vite-plus/test"
import { createUnsavedFiles } from "../src/features/receive/unsavedFiles.ts"

describe("received file save tracking", () => {
  it("keeps leave protection until every distinct file is saved", () => {
    const files = createUnsavedFiles(2)
    expect(files.hasUnsaved).toBe(true)
    expect(files.markSaved(0)).toBe(true)
    expect(files.hasUnsaved).toBe(true)
    expect(files.markSaved(0)).toBe(false)
    expect(files.markSaved(-1)).toBe(false)
    expect(files.markSaved(2)).toBe(false)
    expect(files.markSaved(0.5)).toBe(false)
    expect(files.hasUnsaved).toBe(true)
    expect(files.markSaved(1)).toBe(true)
    expect(files.hasUnsaved).toBe(false)
  })

  it("clears all remaining files only on explicit all-saved or removal", () => {
    const files = createUnsavedFiles(2)
    files.markSaved(0)
    files.markAllSaved()
    expect(files.hasUnsaved).toBe(false)
  })
})
