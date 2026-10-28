import * as fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import { addToSelection, removeFromSelection } from "../src/selection.ts"

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
