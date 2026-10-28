/**
 * The module graph check (docs/decisions/0009). Each package's `package.json` is its declaration: its kind comes from
 * its directory and its edges from `dependencies`. This file holds the rules every declaration must obey, and a pure
 * check that compares declarations with the imports the source actually makes.
 *
 * Adapted from the module-layer check of phibkro/vektorprogrammet-reimagined (that repository's ADR 0015), same author.
 */

export type Kind = "library" | "service" | "platform" | "integration" | "app" | "tool"

interface KindRule {
  readonly directory: string
  /** Kinds this kind may take workspace dependencies on. */
  readonly mayDependOn: ReadonlyArray<Kind>
  /** Outside packages allowed in shipped source, or "any" for kinds that exist to wrap runtimes and vendors. */
  readonly externals: ReadonlyArray<string> | "any"
  /** Whether shipped source may import runtime modules (`node:*`, `bun:*`). */
  readonly runtimeModules: boolean
}

/** The package-kind table of CLAUDE.md, as data. */
export const kindRules: { readonly [K in Kind]: KindRule } = {
  library: { directory: "libraries", mayDependOn: ["library"], externals: ["effect"], runtimeModules: false },
  service: { directory: "services", mayDependOn: ["library"], externals: ["effect"], runtimeModules: false },
  platform: { directory: "platforms", mayDependOn: ["service", "library", "integration"], externals: "any", runtimeModules: true },
  integration: { directory: "integrations", mayDependOn: ["library"], externals: "any", runtimeModules: true },
  app: { directory: "apps", mayDependOn: ["library"], externals: "any", runtimeModules: true },
  tool: { directory: "tools", mayDependOn: ["library", "service", "platform", "integration", "app", "tool"], externals: "any", runtimeModules: true },
}

/** Specifiers that only test code (and files a package marks as test support) may import. */
export const testOnlySpecifiers: ReadonlyArray<string> = ["bun:test", "fast-check", "effect/testing", "@file-transfer/conformance"]

export const workspaceScope = "@file-transfer/"

export interface ImportFact {
  /** Path relative to the package directory. */
  readonly file: string
  readonly specifier: string
  /** True for files under `test/` and `*.test.ts`. */
  readonly inTest: boolean
}

export interface PackageFacts {
  readonly name: string
  readonly kind: Kind
  /** Path relative to the repository root, such as `services/room`. */
  readonly directory: string
  readonly dependencies: ReadonlyArray<string>
  /** Shipped files allowed to import test-only specifiers, from `fileTransfer.testSupportFiles` in package.json. */
  readonly testSupportFiles: ReadonlyArray<string>
  readonly sourceFileCount: number
  readonly imports: ReadonlyArray<ImportFact>
}

export type Violation =
  | { readonly rule: "unknown-workspace-package"; readonly packageName: string; readonly file: string; readonly specifier: string }
  | { readonly rule: "undeclared-dependency"; readonly packageName: string; readonly file: string; readonly dependency: string }
  | { readonly rule: "forbidden-kind-edge"; readonly packageName: string; readonly dependency: string; readonly from: Kind; readonly to: Kind }
  | { readonly rule: "forbidden-external"; readonly packageName: string; readonly dependency: string }
  | { readonly rule: "runtime-module-in-source"; readonly packageName: string; readonly file: string; readonly specifier: string }
  | { readonly rule: "test-only-in-source"; readonly packageName: string; readonly file: string; readonly specifier: string }
  | { readonly rule: "escaping-relative-import"; readonly packageName: string; readonly file: string; readonly specifier: string }
  | { readonly rule: "unused-dependency"; readonly packageName: string; readonly dependency: string }
  | { readonly rule: "dependency-cycle"; readonly packages: ReadonlyArray<string> }

const isRuntimeModule = (specifier: string) => specifier.startsWith("node:") || specifier.startsWith("bun:")
const isRelative = (specifier: string) => specifier.startsWith("./") || specifier.startsWith("../")

/** `@scope/name/sub` becomes `@scope/name`; `name/sub` becomes `name`. */
export const packageOf = (specifier: string): string => {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier)
}

/** Whether a relative import from `file` stays inside the package directory. */
const staysInside = (file: string, specifier: string): boolean => {
  const segments = file.split("/").slice(0, -1)
  for (const part of specifier.split("/")) {
    if (part === "..") {
      if (segments.length === 0) return false
      segments.pop()
    } else if (part !== ".") segments.push(part)
  }
  return true
}

const isTestOnly = (specifier: string) => testOnlySpecifiers.includes(specifier)

export const checkModuleGraph = (packages: ReadonlyArray<PackageFacts>, rootDevelopmentDependencies: ReadonlyArray<string>): Array<Violation> => {
  const violations: Array<Violation> = []
  const byName = new Map(packages.map((facts) => [facts.name, facts]))

  for (const facts of packages) {
    const rule = kindRules[facts.kind]
    const declared = new Set(facts.dependencies)
    const used = new Set<string>()

    for (const dependency of facts.dependencies) {
      const target = byName.get(dependency)
      if (target !== undefined) {
        if (!rule.mayDependOn.includes(target.kind)) violations.push({ rule: "forbidden-kind-edge", packageName: facts.name, dependency, from: facts.kind, to: target.kind })
      } else if (dependency.startsWith(workspaceScope)) {
        violations.push({ rule: "unknown-workspace-package", packageName: facts.name, file: "package.json", specifier: dependency })
      } else if (rule.externals !== "any" && !rule.externals.includes(dependency)) {
        violations.push({ rule: "forbidden-external", packageName: facts.name, dependency })
      }
    }

    for (const fact of facts.imports) {
      const { file, specifier, inTest } = fact
      const shipped = !inTest && !facts.testSupportFiles.includes(file)
      if (isRelative(specifier)) {
        if (!staysInside(file, specifier)) violations.push({ rule: "escaping-relative-import", packageName: facts.name, file, specifier })
        continue
      }
      if (shipped && isTestOnly(specifier)) violations.push({ rule: "test-only-in-source", packageName: facts.name, file, specifier })
      if (isRuntimeModule(specifier)) {
        if (shipped && !rule.runtimeModules) violations.push({ rule: "runtime-module-in-source", packageName: facts.name, file, specifier })
        continue
      }
      const dependency = packageOf(specifier)
      if (dependency === facts.name) continue
      if (dependency.startsWith(workspaceScope) && !byName.has(dependency)) {
        violations.push({ rule: "unknown-workspace-package", packageName: facts.name, file, specifier })
        continue
      }
      used.add(dependency)
      const providedForTests = !shipped && rootDevelopmentDependencies.includes(dependency)
      if (!declared.has(dependency) && !providedForTests) violations.push({ rule: "undeclared-dependency", packageName: facts.name, file, dependency })
    }

    // A package with no source yet may declare the edges it will need; the kind rules above still apply to them.
    if (facts.sourceFileCount > 0) {
      for (const dependency of facts.dependencies) {
        const unknown = dependency.startsWith(workspaceScope) && !byName.has(dependency)
        if (!used.has(dependency) && !unknown) violations.push({ rule: "unused-dependency", packageName: facts.name, dependency })
      }
    }
  }

  violations.push(...findCycles(packages))
  return violations
}

const findCycles = (packages: ReadonlyArray<PackageFacts>): Array<Violation> => {
  const edges = new Map(packages.map((facts) => [facts.name, facts.dependencies.filter((dependency) => packages.some((other) => other.name === dependency))]))
  const state = new Map<string, "visiting" | "done">()
  const cycles: Array<Violation> = []
  const visit = (name: string, path: ReadonlyArray<string>) => {
    if (state.get(name) === "done") return
    if (state.get(name) === "visiting") {
      cycles.push({ rule: "dependency-cycle", packages: [...path.slice(path.indexOf(name)), name] })
      return
    }
    state.set(name, "visiting")
    for (const next of edges.get(name) ?? []) visit(next, [...path, name])
    state.set(name, "done")
  }
  for (const name of [...edges.keys()].sort()) visit(name, [])
  return cycles
}

export const describeViolation = (violation: Violation): string => {
  switch (violation.rule) {
    case "unknown-workspace-package":
      return `${violation.packageName} (${violation.file}): ${violation.specifier} is not a workspace package`
    case "undeclared-dependency":
      return `${violation.packageName} (${violation.file}): imports ${violation.dependency}, which package.json does not declare`
    case "forbidden-kind-edge":
      return `${violation.packageName}: a ${violation.from} may not depend on ${violation.dependency}, a ${violation.to}`
    case "forbidden-external":
      return `${violation.packageName}: depends on ${violation.dependency}, which its kind does not allow`
    case "runtime-module-in-source":
      return `${violation.packageName} (${violation.file}): imports the runtime module ${violation.specifier}, which its kind does not allow`
    case "test-only-in-source":
      return `${violation.packageName} (${violation.file}): shipped code imports the test-only ${violation.specifier}`
    case "escaping-relative-import":
      return `${violation.packageName} (${violation.file}): ${violation.specifier} reaches outside the package`
    case "unused-dependency":
      return `${violation.packageName}: declares ${violation.dependency} but never imports it`
    case "dependency-cycle":
      return `dependency cycle: ${violation.packages.join(" -> ")}`
  }
}
