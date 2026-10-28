import * as fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import { addToSelection, removeFromSelection, renameProblem } from "../src/selection.ts"

const named = (...names: readonly string[]) => names.map((name) => ({ name }))

describe("file selection", () => {
  it("adds batches in order", () => {
    const first = addToSelection([], named("a.txt", "b.txt"))
    const second = addToSelection(first.selected, named("c.bin"))
    expect(second.selected.map((file) => file.name)).toEqual(["a.txt", "b.txt", "c.bin"])
    expect(second.rejected).toEqual([])
  })

  it("rejects a name already chosen, ignoring case, and keeps the first", () => {
    const change = addToSelection(named("Report.pdf"), named("report.PDF", "other.pdf"))
    expect(change.selected.map((file) => file.name)).toEqual(["Report.pdf", "other.pdf"])
    expect(change.rejected).toEqual([{ name: "report.PDF", reason: "a file with the same name is already in the list" }])
  })

  it("rejects names the parcel does not allow, such as Windows device names", () => {
    const change = addToSelection([], named("con.txt", "fine.txt"))
    expect(change.selected.map((file) => file.name)).toEqual(["fine.txt"])
    expect(change.rejected.map((rejection) => rejection.name)).toEqual(["con.txt"])
  })

  it("removes exactly the file at an index", () => {
    expect(removeFromSelection(named("a", "b", "c"), 1).map((file) => file.name)).toEqual(["a", "c"])
  })

  it("never selects a colliding pair, and accounts for every incoming file", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a.txt", "A.TXT", "b.txt", "con.txt", "x/y.txt", "x"), { maxLength: 12 }), (names) => {
        const change = addToSelection([], named(...names))
        const keys = change.selected.map((file) => file.name.toLowerCase())
        expect(new Set(keys).size).toBe(keys.length)
        expect(change.selected.length + change.rejected.length).toBe(names.length)
      }),
    )
  })
})

describe("renameProblem", () => {
  const names = ["report.pdf", "photos/beach.jpg", "notes.txt"]

  it("allows a new valid name, the same name, and a change of case", () => {
    expect(renameProblem(names, 0, "summary.pdf")).toBeUndefined()
    expect(renameProblem(names, 0, "report.pdf")).toBeUndefined()
    expect(renameProblem(names, 0, "Report.PDF")).toBeUndefined()
  })

  it("rejects a name another file has, in any case", () => {
    expect(renameProblem(names, 0, "NOTES.txt")).toBe("another file already has this name")
  })

  it("rejects a name that is also a folder of another file", () => {
    expect(renameProblem(names, 2, "photos")).toBe("another file already has this name")
  })

  it("rejects names the parcel's name rules forbid", () => {
    expect(renameProblem(names, 0, "con.txt")).toMatch(/^the name /u)
    expect(renameProblem(names, 0, "a:b")).toMatch(/^the name /u)
    expect(renameProblem(names, 0, "")).toMatch(/^the name /u)
  })
})
