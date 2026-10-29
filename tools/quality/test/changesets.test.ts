import { describe, expect, it } from "vite-plus/test"
import { isShippedFile, parseChangeset, reviewChangesets, shippedPackageOf } from "../src/changesets.ts"

const packages = [
  { name: "@file-transfer/parcel", directory: "libraries/parcel" },
  { name: "@file-transfer/web", directory: "apps/web" },
  { name: "@file-transfer/tool-quality", directory: "tools/quality" },
]

const ignored = ["@file-transfer/tool-quality"]

describe("parseChangeset", () => {
  it("reads packages, bumps and the summary", () => {
    expect(parseChangeset(".changeset/a.md", "---\n\"@file-transfer/parcel\": minor\n'@file-transfer/web': patch\n---\n\nAdds a thing.\n")).toEqual({
      file: ".changeset/a.md",
      releases: [
        { name: "@file-transfer/parcel", bump: "minor" },
        { name: "@file-transfer/web", bump: "patch" },
      ],
      summary: "Adds a thing.",
    })
  })

  it("reads an empty changeset", () => {
    expect(parseChangeset(".changeset/b.md", "---\n---\n\nDocumentation only.\n")).toEqual({
      file: ".changeset/b.md",
      releases: [],
      summary: "Documentation only.",
    })
  })

  it("refuses anything that is not a changeset, or an unknown bump", () => {
    expect(parseChangeset(".changeset/c.md", "Just text")).toEqual(expect.stringContaining("not a changeset"))
    expect(parseChangeset(".changeset/d.md", '---\n"@file-transfer/web": huge\n---\nx')).toContain("not")
  })
})

describe("shipped files", () => {
  it("leave out tests, development scripts and changelogs", () => {
    expect(isShippedFile("src/parcel.ts")).toBe(true)
    expect(isShippedFile("package.json")).toBe(true)
    expect(isShippedFile("test/parcel.test.ts")).toBe(false)
    expect(isShippedFile("scripts/endToEnd.ts")).toBe(false)
    expect(isShippedFile("CHANGELOG.md")).toBe(false)
    expect(shippedPackageOf("libraries/parcel/src/seal.ts", packages)).toBe("@file-transfer/parcel")
    expect(shippedPackageOf("docs/plan.md", packages)).toBeUndefined()
  })
})

const changeset = (releases: readonly { name: string; bump: "major" | "minor" | "patch" }[], summary = "Something changed.") => ({
  file: ".changeset/x.md",
  releases,
  summary,
})

describe("reviewChangesets", () => {
  it("requires a changeset, even an empty one", () => {
    expect(reviewChangesets({ changedFiles: ["docs/plan.md"], addedChangesets: [], packages, ignored }).violations).toHaveLength(1)
    expect(reviewChangesets({ changedFiles: ["docs/plan.md"], addedChangesets: [changeset([])], packages, ignored }).violations).toEqual([])
  })

  it("lets automated updates leave out the empty changeset, but not a needed one", () => {
    const automated = { addedChangesets: [], packages, ignored, requireEmpty: false }

    expect(reviewChangesets({ ...automated, changedFiles: ["spikes/0003/package.json", "bun.lock"] }).violations).toEqual([])
    expect(reviewChangesets({ ...automated, changedFiles: ["tools/quality/package.json"] }).violations).toEqual([])
    expect(reviewChangesets({ ...automated, changedFiles: ["libraries/parcel/package.json"] }).violations).toEqual([
      expect.stringContaining("adds no changeset"),
      expect.stringContaining("@file-transfer/parcel changed"),
    ])
  })

  it("requires every changed package to be named", () => {
    const review = reviewChangesets({
      changedFiles: ["libraries/parcel/src/seal.ts", "apps/web/src/main.ts", "tools/quality/src/x.ts"],
      addedChangesets: [changeset([{ name: "@file-transfer/web", bump: "patch" }])],
      packages,
      ignored,
    })

    expect(review.violations).toEqual([expect.stringContaining("@file-transfer/parcel changed")])
  })

  it("refuses unknown or ignored packages and empty summaries", () => {
    const review = reviewChangesets({
      changedFiles: [],
      addedChangesets: [
        changeset([{ name: "@file-transfer/nothing", bump: "patch" }]),
        changeset([{ name: "@file-transfer/tool-quality", bump: "patch" }]),
        changeset([], ""),
      ],
      packages,
      ignored,
    })

    expect(review.violations).toHaveLength(3)
  })

  it("lists the strongest bump of each seam package for review", () => {
    const review = reviewChangesets({
      changedFiles: ["libraries/parcel/src/seal.ts"],
      addedChangesets: [changeset([{ name: "@file-transfer/parcel", bump: "patch" }]), changeset([{ name: "@file-transfer/parcel", bump: "major" }])],
      packages,
      ignored,
    })

    expect(review.seams).toEqual([{ name: "@file-transfer/parcel", bump: "major" }])
  })
})
