/** Reads the workspace from disk into the facts `checkModuleGraph` compares. */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { parseSync } from "oxc-parser"
import { kindRules } from "./moduleGraph.ts"
import type { Kind, PackageFacts } from "./moduleGraph.ts"

interface Manifest {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly fileTransfer?: { readonly testSupportFiles?: readonly string[] }
}

const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8")) as Manifest

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    if (entry === "node_modules" || entry.startsWith(".")) {
      return []
    }

    const path = join(directory, entry)

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

    return /^(["'])[^"']*\1$/u.test(text) ? [text.slice(1, -1)] : []
  })

  return [
    ...module.staticImports.map((entry) => entry.moduleRequest.value),
    ...module.staticExports.flatMap((entry) => entry.entries.flatMap((exported) => (exported.moduleRequest === null ? [] : [exported.moduleRequest.value]))),
    ...dynamic,
  ]
}

/** Files that never ship: tests, development scripts (integration and end-to-end checks) and deployment declarations. */
const isDevelopmentOnly = (file: string) => file.startsWith("test/") || file.startsWith("scripts/") || file.endsWith(".test.ts") || file === "alchemy.run.ts"

export const loadWorkspace = (root: string): { readonly packages: PackageFacts[]; readonly rootDevelopmentDependencies: string[] } => {
  const rootManifest = readManifest(join(root, "package.json"))
  const packages: PackageFacts[] = []

  for (const [kind, rule] of Object.entries(kindRules) as [Kind, (typeof kindRules)[Kind]][]) {
    const kindDirectory = join(root, rule.directory)
    let entries: string[]

    try {
      entries = readdirSync(kindDirectory)
    } catch {
      continue
    }

    for (const entry of entries.toSorted()) {
      const packageDirectory = join(kindDirectory, entry)
      let manifest: Manifest

      try {
        manifest = readManifest(join(packageDirectory, "package.json"))
      } catch {
        continue
      }

      const files = sourceFiles(packageDirectory)
      packages.push({
        name: manifest.name,
        kind,
        directory: relative(root, packageDirectory),
        dependencies: Object.keys(manifest.dependencies ?? {}).toSorted(),
        developmentDependencies: Object.keys(manifest.devDependencies ?? {}).toSorted(),
        testSupportFiles: manifest.fileTransfer?.testSupportFiles ?? [],
        sourceFileCount: files.length,
        imports: files.flatMap((path) => {
          const file = relative(packageDirectory, path)

          return importSpecifiers(path, readFileSync(path, "utf8")).map((specifier) => ({ file, specifier, developmentOnly: isDevelopmentOnly(file) }))
        }),
      })
    }
  }

  return { packages, rootDevelopmentDependencies: Object.keys(rootManifest.devDependencies ?? {}) }
}
