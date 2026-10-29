import { describe, expect, it } from "vite-plus/test"
import { lockfileDrift } from "../src/lockfile.ts"
import { textNow } from "../src/repository.ts"
import { manifestVersion } from "../src/workspace.ts"

const root = new URL("../../../", import.meta.url).pathname

const lock = `{
  "lockfileVersion": 2,
  "workspaces": {
    "": {
      "name": "root",
      "dependencies": {
        "effect": "^4.0.7",
      },
    },
    "apps/web": {
      "name": "@example/web",
      "version": "0.4.0",
    },
  },
}`

describe("lockfile drift", () => {
  it("finds nothing when every locked version matches its manifest", () => {
    expect(lockfileDrift(lock, (path) => (path === "apps/web" ? "0.4.0" : undefined))).toEqual([])
  })

  it("names a workspace whose manifest was bumped without refreshing the lockfile", () => {
    expect(lockfileDrift(lock, (path) => (path === "apps/web" ? "0.4.1" : undefined))).toEqual(["apps/web: bun.lock has 0.4.0, package.json has 0.4.1"])
  })

  it("holds for this repository (run `bun install --lockfile-only` to refresh bun.lock)", () => {
    // An empty text fails to parse, so a missing bun.lock fails here rather than passing with nothing to compare.
    expect(lockfileDrift(textNow(root, "bun.lock") ?? "", manifestVersion(root))).toEqual([])
  })
})
