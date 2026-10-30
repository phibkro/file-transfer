import { describe, expect, it } from "vite-plus/test"
import { effectFamilyDrift, lockfileDrift } from "../src/lockfile.ts"
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

const familyLock = (sqlVersion: string) => `{
  "lockfileVersion": 2,
  "packages": {
    "@effect/sql-d1": ["@effect/sql-d1@${sqlVersion}", "", { "peerDependencies": { "effect": "^4.1.0" } }, "sha512-"],
    "@effect/tsgo": ["@effect/tsgo@0.48.0", "", {}, "sha512-"],
    "@file-transfer/sink": ["@file-transfer/sink@workspace:libraries/sink"],
    "effect": ["effect@4.1.0", "", {}, "sha512-"],
  },
}`

describe("effect family drift", () => {
  it("finds nothing when every @effect package is at the effect version, ignoring @effect/tsgo's own line", () => {
    expect(effectFamilyDrift(familyLock("4.1.0"))).toEqual([])
  })

  it("names an @effect package locked at another version than effect", () => {
    expect(effectFamilyDrift(familyLock("4.1.1"))).toEqual(["@effect/sql-d1@4.1.1: bun.lock has effect@4.1.0"])
  })

  it("names effect when it is locked at more than one version", () => {
    const twice = familyLock("4.1.0").replace(
      '"effect": ["effect@4.1.0"',
      '"other/effect": ["effect@4.0.7", "", {}, "sha512-"],\n    "effect": ["effect@4.1.0"',
    )

    expect(effectFamilyDrift(twice)).toEqual(["effect: bun.lock has 4.0.7, 4.1.0"])
  })

  it("holds for this repository (move effect and every @effect package, overrides included, together)", () => {
    expect(effectFamilyDrift(textNow(root, "bun.lock") ?? "")).toEqual([])
  })
})
