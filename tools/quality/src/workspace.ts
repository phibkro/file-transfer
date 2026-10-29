/** Reads the workspace from disk into the facts `checkModuleGraph` compares. */
import { readdirSync, readFileSync, statSync } from "node:fs"
import nodePath from "node:path"
import { parseSync } from "oxc-parser"
import { kindRules } from "./moduleGraph.ts"
import type { Kind, PackageFacts } from "./moduleGraph.ts"

interface Manifest {
  readonly name: string
  readonly version?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly fileTransfer?: { readonly testSupportFiles?: readonly string[] }
}

// SAFETY: every package.json in this repository is a manifest; the checks below read only the fields Manifest declares.
const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, "utf-8")) as Manifest

/** The `version` the package.json of the workspace at `path` (relative to `root`, "" for the root) declares. */
export const manifestVersion =
  (root: string) =>
  (path: string): string | undefined =>
    readManifest(nodePath.join(root, path, "package.json")).version

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    if (entry === "node_modules" || entry.startsWith(".")) {
      return []
    }

    const path = nodePath.join(directory, entry)

    if (statSync(path).isDirectory()) {
      return sourceFiles(path)
    }

    return path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : []
  })

/** Every module a file imports or re-exports, statically or through `import("literal")`. */
const importSpecifiers = (path: string, source: string): string[] => {
  const { module, errors } = parseSync(path, source)

  if (errors.length > 0) {
    return [`<unparsable: ${errors[0]?.message ?? "unknown error"}>`]
  }

  const dynamic = module.dynamicImports.flatMap(({ moduleRequest }) => {
    const text = source.slice(moduleRequest.start, moduleRequest.end)

    return /^(?<quote>["'])[^"']*\k<quote>$/u.test(text) ? [text.slice(1, -1)] : []
  })

  return [
    ...module.staticImports.map((entry) => entry.moduleRequest.value),
    ...module.staticExports.flatMap((entry) => entry.entries.flatMap((exported) => (exported.moduleRequest === null ? [] : [exported.moduleRequest.value]))),
    ...dynamic,
  ]
}

/** Files that never ship: tests, development scripts (integration and end-to-end checks) and deployment declarations. */
const isDevelopmentOnly = (file: string) => file.startsWith("test/") || file.startsWith("scripts/") || file.endsWith(".test.ts") || file === "alchemy.run.ts"

/** Every package's facts, and the development dependencies the root provides to tests. */
export interface Workspace {
  readonly packages: PackageFacts[]
  readonly rootDevelopmentDependencies: string[]
}

export const loadWorkspace = (root: string): Workspace => {
  const rootManifest = readManifest(nodePath.join(root, "package.json"))
  const packages: PackageFacts[] = []

  // SAFETY: kindRules has exactly one entry per Kind, so its entries are Kind keys with their rules.
  for (const [kind, rule] of Object.entries(kindRules) as [Kind, (typeof kindRules)[Kind]][]) {
    const kindDirectory = nodePath.join(root, rule.directory)
    let entries: string[]

    try {
      entries = readdirSync(kindDirectory)
    } catch {
      continue
    }

    for (const entry of entries.toSorted()) {
      const packageDirectory = nodePath.join(kindDirectory, entry)
      let manifest: Manifest

      try {
        manifest = readManifest(nodePath.join(packageDirectory, "package.json"))
      } catch {
        continue
      }

      const files = sourceFiles(packageDirectory)
      packages.push({
        name: manifest.name,
        kind,
        directory: nodePath.relative(root, packageDirectory),
        dependencies: Object.keys(manifest.dependencies ?? {}).toSorted(),
        developmentDependencies: Object.keys(manifest.devDependencies ?? {}).toSorted(),
        testSupportFiles: manifest.fileTransfer?.testSupportFiles ?? [],
        sourceFileCount: files.length,
        imports: files.flatMap((path) => {
          const file = nodePath.relative(packageDirectory, path)

          return importSpecifiers(path, readFileSync(path, "utf-8")).map((specifier) => ({ file, specifier, developmentOnly: isDevelopmentOnly(file) }))
        }),
      })
    }
  }

  return { packages, rootDevelopmentDependencies: Object.keys(rootManifest.devDependencies ?? {}) }
}
