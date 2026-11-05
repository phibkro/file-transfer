import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseSync } from "oxc-parser"

const declaration = (file: string, source: string, expected: string) => {
  const result = parseSync(file, source)
  if (result.errors.length) throw new Error(`Invalid TypeScript in ${file}`)
  for (const statement of result.program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.declaration?.type !== "VariableDeclaration") continue
    for (const variable of statement.declaration.declarations) {
      if (variable.id.type !== "Identifier" || variable.id.name !== "Route") continue
      const call = variable.init
      if (call?.type !== "CallExpression" || call.callee.type !== "CallExpression" || call.callee.callee.type !== "Identifier" || call.callee.callee.name !== "createFileRoute") break
      const id = call.callee.arguments[0]
      if (id?.type !== "Literal" || id.value !== expected) break
      const options = call.arguments[0]
      if (options?.type !== "ObjectExpression") break
      const property = (name: string) => options.properties.find((entry) => entry.type === "Property" && entry.key.type === "Identifier" && entry.key.name === name)
      const tag = property("tag")
      const main = property("main")
      if (!tag || tag.type !== "Property" || tag.value.type !== "Literal" || typeof tag.value.value !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(tag.value.value)) break
      if (main && (main.type !== "Property" || main.value.type !== "Literal" || typeof main.value.value !== "boolean")) break
      return { tag: tag.value.value, main: main?.type === "Property" && main.value.type === "Literal" && main.value.value === true }
    }
  }
  throw new Error(`Invalid Route declaration in ${file}: expected createFileRoute("${expected}") with literal tag`)
}

export interface FileRoute { readonly file: string; readonly id: string; readonly path: string; readonly parent: string; readonly tag: string; readonly main: boolean; readonly layout: boolean; readonly segments: readonly string[] }

export const inventory = (files: ReadonlyArray<{ readonly file: string; readonly source: string }>): ReadonlyArray<FileRoute> => {
  const names = new Set(files.map(({ file }) => file))
  if (!names.has("__root.ts")) throw new Error("Missing __root.ts")
  const routes: FileRoute[] = []
  for (const { file, source } of [...files].sort((a, b) => a.file.localeCompare(b.file, "en"))) {
    if (file === "__root.ts") continue
    if (!file.endsWith(".ts") || file.includes("/")) throw new Error(`Unsupported route file: ${file}`)
    const parts = file.slice(0, -3).split(".")
    if (parts.some((part, index) => !/^(?:_[a-z][a-z0-9-]*|\$[A-Za-z][A-Za-z0-9]*|[a-z][a-z0-9-]*)$/.test(part) || (part === "index" && index !== parts.length - 1))) throw new Error(`Unsupported route file: ${file}`)
    for (let index = 0; index < parts.length - 1; index++) {
      if (parts[index]!.startsWith("_") && !names.has(parts.slice(0, index + 1).join(".") + ".ts")) throw new Error(`Missing parent for ${file}`)
    }
    const last = parts.at(-1)!
    const layout = last.startsWith("_")
    const segments = parts.filter((part) => !part.startsWith("_") && part !== "index")
    const path = "/" + segments.join("/")
    const id = "/" + parts.map((part) => part === "index" ? "" : part).join("/")
    const { tag, main } = declaration(file, source, id)
    const parentParts = parts.slice(0, -1)
    while (parentParts.length && !names.has(parentParts.join(".") + ".ts")) parentParts.pop()
    routes.push({ file, id, path, parent: parentParts.length ? "/" + parentParts.join("/") : "__root", tag, main, layout, segments })
  }
  const seenPaths = new Set<string>(), seenTags = new Set<string>(), dynamics = new Map<string, string>()
  for (const route of routes) {
    if (seenTags.has(route.tag)) throw new Error(`Duplicate route tag: ${route.tag}`)
    seenTags.add(route.tag)
    if (route.layout) continue
    if (seenPaths.has(route.path)) throw new Error(`Duplicate route path: ${route.path}`)
    seenPaths.add(route.path)
    route.segments.forEach((segment, index) => {
      if (!segment.startsWith("$")) return
      const prefix = route.segments.slice(0, index).map((part) => part.startsWith("$") ? "$" : part).join("/")
      const existing = dynamics.get(prefix)
      if (existing && existing !== segment) throw new Error(`Ambiguous dynamic siblings at ${prefix}`)
      dynamics.set(prefix, segment)
    })
  }
  return routes
}

export const renderFileRoutes = (routes: ReadonlyArray<FileRoute>): string => {
  const pages = routes.filter((route) => !route.layout)
  const imports = routes.map((route, index) => `import { Route as route${index} } from "../routes/${route.file}"`).join("\n")
  const name = (route: FileRoute) => `route${routes.indexOf(route)}`
  const schema = (route: FileRoute) => route.segments.filter((part) => part.startsWith("$")).map((part) => `${part.slice(1)}: ${name(route)}.options.params.${part.slice(1)}`).join(", ")
  const parser = (route: FileRoute) => {
    const pieces = route.segments.map((segment) => segment.startsWith("$") ? `Route.schemaSegment("${segment.slice(1)}", ${name(route)}.options.params.${segment.slice(1)})` : `Route.literal("${segment}")`)
    return `pipe(${pieces.length ? pieces[0] : "Route.root"}${pieces.slice(1).map((piece) => `, Route.slash(${piece})`).join("")}, Route.mapTo(AppRoute.${route.tag}))`
  }
  const paths = pages.map((route) => `  ${JSON.stringify(route.path)}: ${route.tag.charAt(0).toLowerCase() + route.tag.slice(1)}Router,`).join("\n")
  return `// Generated by scripts/fileRoutes.ts. Do not edit.\nimport { Effect, pipe } from "effect"\nimport * as Route from "foldkit/route"\nimport { Route as rootRoute } from "../routes/__root.ts"\n${imports}\n\nexport const AppRoute = Route.defineRouteUnion({\n${pages.map((route) => `  ${route.tag}: { ${schema(route)} },`).join("\n")}\n})\nexport const MainRoute = AppRoute.subset([${pages.filter((route) => route.main).map((route) => JSON.stringify(route.tag)).join(", ")}])\n${pages.map((route) => `export const ${route.tag.charAt(0).toLowerCase() + route.tag.slice(1)}Router = ${parser(route)}`).join("\n")}\nexport const router = Route.oneOf(${pages.map((route) => route.tag.charAt(0).toLowerCase() + route.tag.slice(1) + "Router").join(", ")})\nexport const routeTree = { root: rootRoute, routes: [\n${routes.map((route) => `  { route: ${name(route)}, id: ${JSON.stringify(route.id)}, parent: ${JSON.stringify(route.parent)}, path: ${JSON.stringify(route.path)}, layout: ${route.layout} },`).join("\n")}\n] } as const\n\nconst builders = {\n${paths}\n} as const\nexport type RoutePath = keyof typeof builders\ntype BuilderArguments<Path extends RoutePath> = Parameters<(typeof builders)[Path]>\nexport const buildPath = <Path extends RoutePath>(path: Path, ...args: BuilderArguments<Path>): string => {\n  const builder = builders[path] as (...values: BuilderArguments<Path>) => string\n  return builder(...args).split("/").map(encodeURIComponent).join("/")\n}\n\n// Accept pathname only: never inspect an href, query, or fragment.\nexport const parsePath = (pathname: string) => {\n  if (!pathname.startsWith("/") || pathname.includes("?") || pathname.includes("#") || pathname.includes("//")) return undefined\n  const raw = pathname === "/" ? [] : (pathname.endsWith("/") ? pathname.slice(0, -1) : pathname).slice(1).split("/")\n  let segments: string[]\n  try { segments = raw.map(decodeURIComponent) } catch { return undefined }\n  if (segments.some((segment) => segment.includes("/"))) return undefined\n  const result = Effect.runSync(Effect.option(router.parse(segments)))\n  return result._tag === "Some" ? result.value[0] : AppRoute.QuickShare.make({})\n}\n`
}

export const generateFileRoutes = async (root: string, check = false): Promise<void> => {
  const directory = join(root, "src/routes")
  const files = await readdir(directory)
  const routes = inventory(await Promise.all(files.map(async (file) => ({ file, source: await readFile(join(directory, file), "utf8") }))))
  const output = renderFileRoutes(routes)
  const destination = join(root, "src/routing/routeTree.gen.ts")
  const current = await readFile(destination, "utf8").catch(() => "")
  if (current === output) return
  if (check) throw new Error("Generated route tree is stale")
  await writeFile(destination, output)
}
