import { describe, expect, it } from "vite-plus/test"
import { composeReleaseNotes, prependToChangelog, sectionFor } from "../src/releaseNotes.ts"

const parcel = `# @file-transfer/parcel

## 0.2.0

### Minor Changes

- abc1234: Adds parcel v2 alongside v1.

## 0.1.0

### Minor Changes

- 0000000: First release.
`

const platform = `# @file-transfer/platform-self-hosted

## 0.2.0

No changes in this release.
`

describe("sectionFor", () => {
  it("takes one version's section and nothing after it", () => {
    expect(sectionFor(parcel, "0.2.0")).toBe("### Minor Changes\n\n- abc1234: Adds parcel v2 alongside v1.")
    expect(sectionFor(parcel, "0.1.0")).toBe("### Minor Changes\n\n- 0000000: First release.")
  })

  it("skips a missing version and one with nothing in it", () => {
    expect(sectionFor(parcel, "9.9.9")).toBeUndefined()
    expect(sectionFor(platform, "0.2.0")).toBeUndefined()
  })
})

describe("composeReleaseNotes", () => {
  it("lists each package's changes under the release, headings one level down", () => {
    const notes = composeReleaseNotes("v0.2.0", [
      { name: "@file-transfer/parcel", version: "0.2.0", changelog: parcel },
      { name: "@file-transfer/platform-self-hosted", version: "0.2.0", changelog: platform },
    ])

    expect(notes).toBe("## v0.2.0\n\n### @file-transfer/parcel 0.2.0\n\n#### Minor Changes\n\n- abc1234: Adds parcel v2 alongside v1.")
  })

  it("says so when only version numbers changed", () => {
    expect(composeReleaseNotes("v0.2.1", [])).toBe("## v0.2.1\n\nNo changes besides version numbers.")
  })
})

describe("prependToChangelog", () => {
  it("starts the changelog, then puts each release above the earlier ones", () => {
    const first = prependToChangelog(undefined, "## v0.1.0\n\nFirst.")
    expect(first.startsWith("# Changelog\n")).toBe(true)
    expect(first.endsWith("## v0.1.0\n\nFirst.\n")).toBe(true)
    const second = prependToChangelog(first, "## v0.2.0\n\nSecond.")
    expect(second.indexOf("## v0.2.0")).toBeLessThan(second.indexOf("## v0.1.0"))
    expect(second.match(/# Changelog/gu)).toHaveLength(1)
  })
})
