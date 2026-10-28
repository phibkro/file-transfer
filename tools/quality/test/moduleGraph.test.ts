import { describe, expect, it } from "vite-plus/test"
import { checkModuleGraph, describeViolation } from "../src/moduleGraph.ts"
import type { PackageFacts, Violation } from "../src/moduleGraph.ts"
import { loadWorkspace } from "../src/workspace.ts"

const root = new URL("../../../", import.meta.url).pathname

describe("module graph", () => {
  it("the repository obeys every rule", () => {
    const { packages, rootDevelopmentDependencies } = loadWorkspace(root)
    expect(checkModuleGraph(packages, rootDevelopmentDependencies).map(describeViolation)).toEqual([])
  })
})

/** A small valid workspace; each negative control below breaks one rule in it. */
const library: PackageFacts = {
  name: "@file-transfer/parcel",
  kind: "library",
  directory: "libraries/parcel",
  dependencies: [],
  developmentDependencies: [],
  testSupportFiles: [],
  sourceFileCount: 1,
  imports: [{ file: "src/index.ts", specifier: "./constants.ts", developmentOnly: false }],
}

const service: PackageFacts = {
  name: "@file-transfer/service-room",
  kind: "service",
  directory: "services/room",
  dependencies: ["@file-transfer/parcel", "effect"],
  developmentDependencies: [],
  testSupportFiles: [],
  sourceFileCount: 2,
  imports: [
    { file: "src/index.ts", specifier: "@file-transfer/parcel", developmentOnly: false },
    { file: "src/index.ts", specifier: "effect", developmentOnly: false },
    { file: "test/room.test.ts", specifier: "vite-plus/test", developmentOnly: true },
    { file: "test/room.test.ts", specifier: "fast-check", developmentOnly: true },
  ],
}

const platform: PackageFacts = {
  name: "@file-transfer/platform-cloudflare",
  kind: "platform",
  directory: "platforms/cloudflare",
  dependencies: ["@file-transfer/service-room"],
  developmentDependencies: [],
  testSupportFiles: [],
  sourceFileCount: 1,
  imports: [
    { file: "src/index.ts", specifier: "@file-transfer/service-room", developmentOnly: false },
    { file: "src/index.ts", specifier: "node:crypto", developmentOnly: false },
    { file: "src/index.ts", specifier: "cloudflare:workers", developmentOnly: false },
  ],
}

const valid = [library, service, platform]
const developmentDependencies = ["fast-check", "vite-plus"]

const rulesBroken = (packages: readonly PackageFacts[]): Violation["rule"][] =>
  [...new Set(checkModuleGraph(packages, developmentDependencies).map((violation) => violation.rule))].toSorted()

const replace = (original: PackageFacts, changes: Partial<PackageFacts>) => valid.map((facts) => (facts === original ? { ...facts, ...changes } : facts))

describe("module graph negative controls", () => {
  it("the valid example passes", () => {
    expect(rulesBroken(valid)).toEqual([])
  })

  it("rejects an import that package.json does not declare", () => {
    expect(rulesBroken(replace(service, { dependencies: ["effect"] }))).toEqual(["undeclared-dependency"])
  })

  it("allows a package devDependency in development-only files and rejects it in shipped code", () => {
    const withScript = {
      developmentDependencies: ["playwright"],
      imports: [...platform.imports, { file: "scripts/endToEnd.ts", specifier: "playwright", developmentOnly: true }],
    }

    expect(rulesBroken(replace(platform, withScript))).toEqual([])

    const shipped = {
      developmentDependencies: ["playwright"],
      imports: [...platform.imports, { file: "src/index.ts", specifier: "playwright", developmentOnly: false }],
    }

    expect(rulesBroken(replace(platform, shipped))).toEqual(["undeclared-dependency"])
  })

  it("rejects a dependency on a kind the rules forbid", () => {
    const leaky = replace(library, {
      dependencies: ["@file-transfer/service-room"],
      imports: [{ file: "src/index.ts", specifier: "@file-transfer/service-room", developmentOnly: false }],
    })

    expect(rulesBroken(leaky)).toEqual(["dependency-cycle", "forbidden-kind-edge"])
  })

  it("rejects a vendor package in a service", () => {
    const vendor = replace(service, {
      dependencies: [...service.dependencies, "partyserver"],
      imports: [...service.imports, { file: "src/index.ts", specifier: "partyserver", developmentOnly: false }],
    })

    expect(rulesBroken(vendor)).toEqual(["forbidden-external"])
  })

  it("rejects a runtime module in shipped service code but allows it in a platform", () => {
    const runtime = replace(service, { imports: [...service.imports, { file: "src/index.ts", specifier: "node:fs", developmentOnly: false }] })
    expect(rulesBroken(runtime)).toEqual(["runtime-module-in-source"])
    const workers = replace(service, { imports: [...service.imports, { file: "src/index.ts", specifier: "cloudflare:workers", developmentOnly: false }] })
    expect(rulesBroken(workers)).toEqual(["runtime-module-in-source"])
  })

  it("rejects a test-only import in shipped code unless the file is test support", () => {
    const shipped = { file: "src/index.ts", specifier: "bun:test", developmentOnly: false }
    expect(rulesBroken(replace(service, { imports: [...service.imports, shipped] }))).toEqual(["runtime-module-in-source", "test-only-in-source"])
    expect(rulesBroken(replace(service, { testSupportFiles: ["src/index.ts"], imports: [...service.imports, shipped] }))).toEqual([])
  })

  it("rejects a relative import that leaves the package", () => {
    expect(rulesBroken(replace(library, { imports: [{ file: "src/index.ts", specifier: "../../sink/src/index.ts", developmentOnly: false }] }))).toEqual([
      "escaping-relative-import",
    ])
  })

  it("rejects a declared dependency that nothing imports, unless the package has no source yet", () => {
    expect(rulesBroken(replace(service, { dependencies: [...service.dependencies, "@file-transfer/machine"] }))).toEqual(["unknown-workspace-package"])
    const unused = [...valid, { ...library, name: "@file-transfer/machine", directory: "libraries/machine" }]
    const withUnused = unused.map((facts) => (facts === service ? { ...facts, dependencies: [...facts.dependencies, "@file-transfer/machine"] } : facts))
    expect(rulesBroken(withUnused)).toEqual(["unused-dependency"])
    expect(rulesBroken(withUnused.map((facts) => (facts.name === service.name ? { ...facts, sourceFileCount: 0, imports: [] } : facts)))).toEqual([])
  })

  it("rejects an import of a workspace package that does not exist", () => {
    const ghost = replace(service, { imports: [...service.imports, { file: "src/index.ts", specifier: "@file-transfer/ghost", developmentOnly: false }] })
    expect(rulesBroken(ghost)).toEqual(["unknown-workspace-package"])
  })
})
