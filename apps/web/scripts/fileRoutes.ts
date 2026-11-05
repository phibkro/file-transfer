import { Data, Effect, FileSystem, Path } from "effect"
import { parseSync } from "oxc-parser"
import { format } from "vite-plus/fmt"
import { formatOptions } from "./formatOptions.ts"
import { renderFileRoutes } from "./renderFileRoutes.ts"

export { renderFileRoutes } from "./renderFileRoutes.ts"

const validateProperties = (
  properties: readonly { type: string; computed?: boolean; key?: { type: string; name?: unknown; value?: unknown } }[],
  file: string,
) => {
  const names = new Set<string>()

  for (const property of properties) {
    const { key } = property
    let name: string | undefined

    if (key?.type === "Identifier" && typeof key.name === "string") {
      name = key.name
    } else if (key?.type === "Literal" && typeof key.value === "string") {
      name = key.value
    }

    if (property.type !== "Property" || property.computed === true || name === undefined || names.has(name)) {
      throw new Error(`Invalid or duplicate property in ${file}`)
    }

    names.add(name)
  }
}

const declaration = (file: string, source: string, expected: string | undefined) => {
  const result = parseSync(file, source)

  if (result.errors.length) {
    throw new Error(`Invalid TypeScript in ${file}`)
  }

  for (const statement of result.program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.declaration?.type !== "VariableDeclaration") {
      continue
    }

    for (const variable of statement.declaration.declarations) {
      if (variable.id.type !== "Identifier" || variable.id.name !== "Route") {
        continue
      }

      const call = variable.init

      if (expected === undefined) {
        if (
          call?.type !== "CallExpression" ||
          call.callee.type !== "Identifier" ||
          call.callee.name !== "createRootRoute" ||
          call.arguments.length !== 1 ||
          call.arguments[0]?.type !== "ObjectExpression"
        ) {
          break
        }

        validateProperties(call.arguments[0].properties, file)

        if (call.arguments[0].properties.length !== 0) {
          throw new Error(`Root route cannot declare page metadata in ${file}`)
        }

        return { tag: "", main: false, staticPage: false }
      }

      if (
        call?.type !== "CallExpression" ||
        call.arguments.length !== 1 ||
        call.callee.type !== "CallExpression" ||
        call.callee.arguments.length !== 1 ||
        call.callee.callee.type !== "Identifier" ||
        call.callee.callee.name !== "createFileRoute"
      ) {
        break
      }

      const id = call.callee.arguments[0]

      if (id?.type !== "Literal" || id.value !== expected) {
        break
      }

      const options = call.arguments[0]

      if (options?.type !== "ObjectExpression") {
        break
      }

      validateProperties(options.properties, file)

      const property = (name: string) =>
        options.properties.find(
          (entry) =>
            entry.type === "Property" &&
            ((entry.key.type === "Identifier" && entry.key.name === name) || (entry.key.type === "Literal" && entry.key.value === name)),
        )

      const tag = property("tag")
      const main = property("main")
      const params = property("params")
      const staticPage = property("staticPage")
      const workspaceSection = property("workspaceSection")

      if (
        workspaceSection &&
        (workspaceSection.type !== "Property" ||
          workspaceSection.value.type !== "Literal" ||
          (workspaceSection.value.value !== "quick" && workspaceSection.value.value !== "library"))
      ) {
        break
      }

      if (
        workspaceSection &&
        (main?.type !== "Property" || main.value.type !== "Literal" || main.value.value !== true || !expected.startsWith("/_workspace/") || staticPage)
      ) {
        throw new Error(`Conflicting workspace metadata in ${file}`)
      }

      if (staticPage && main?.type === "Property" && main.value.type === "Literal" && main.value.value === true) {
        throw new Error(`Conflicting static and main metadata in ${file}`)
      }

      if (staticPage && (staticPage.type !== "Property" || staticPage.value.type !== "ObjectExpression")) {
        break
      }

      if (staticPage?.type === "Property" && staticPage.value.type === "ObjectExpression") {
        validateProperties(staticPage.value.properties, file)
      }

      if (params?.type === "Property" && params.value.type === "ObjectExpression") {
        validateProperties(params.value.properties, file)
      }

      if (
        !tag ||
        tag.type !== "Property" ||
        tag.value.type !== "Literal" ||
        typeof tag.value.value !== "string" ||
        !/^[A-Z][A-Za-z0-9]*$/u.test(tag.value.value)
      ) {
        break
      }

      if (main && (main.type !== "Property" || main.value.type !== "Literal" || typeof main.value.value !== "boolean")) {
        break
      }

      return { tag: tag.value.value, main: main?.type === "Property" && main.value.type === "Literal" && main.value.value === true, staticPage: !!staticPage }
    }
  }

  throw new Error(`Invalid Route declaration in ${file}: expected createFileRoute("${expected}") with literal tag`)
}

export interface FileRoute {
  readonly file: string
  readonly id: string
  readonly path: string
  readonly parent: string
  readonly tag: string
  readonly main: boolean
  readonly staticPage: boolean
  readonly layout: boolean
  readonly segments: readonly string[]
}

export const inventory = (files: readonly { readonly file: string; readonly source: string }[]): readonly FileRoute[] => {
  const names = new Set(files.map(({ file }) => file))

  if (names.size !== files.length) {
    throw new Error("Duplicate route file")
  }

  const root = files.find(({ file }) => file === "__root.ts")

  if (!root) {
    throw new Error("Missing __root.ts")
  }

  declaration(root.file, root.source, undefined)
  const routes: FileRoute[] = []

  for (const { file, source } of files.toSorted((a, b) => a.file.localeCompare(b.file, "en"))) {
    if (file === "__root.ts") {
      continue
    }

    if (!file.endsWith(".ts") || file.includes("/")) {
      throw new Error(`Unsupported route file: ${file}`)
    }

    const parts = file.slice(0, -3).split(".")

    if (
      parts.some(
        (part, index) => !/^(?:_[a-z][a-z0-9-]*|\$[A-Za-z][A-Za-z0-9]*|[a-z][a-z0-9-]*)$/u.test(part) || (part === "index" && index !== parts.length - 1),
      )
    ) {
      throw new Error(`Unsupported route file: ${file}`)
    }

    for (let index = 0; index < parts.length - 1; index++) {
      if (parts[index]?.startsWith("_") === true && !names.has(`${parts.slice(0, index + 1).join(".")}.ts`)) {
        throw new Error(`Missing parent for ${file}`)
      }
    }

    const last = parts.at(-1) ?? ""
    const layout = last.startsWith("_")
    const segments = parts.filter((part) => !part.startsWith("_") && part !== "index")
    const parameters = segments.filter((segment) => segment.startsWith("$"))

    if (new Set(parameters).size !== parameters.length) {
      throw new Error(`Duplicate route parameter in ${file}`)
    }

    const path = `/${segments.join("/")}`
    const id = `/${parts.map((part) => (part === "index" ? "" : part)).join("/")}`
    const { tag, main, staticPage } = declaration(file, source, id)

    if (staticPage && (layout || parameters.length > 0)) {
      throw new Error(`Static page requires a literal page path in ${file}`)
    }

    const parentParts = parts.slice(0, -1)

    while (parentParts.length > 0 && !names.has(`${parentParts.join(".")}.ts`)) {
      parentParts.pop()
    }

    routes.push({ file, id, path, parent: parentParts.length > 0 ? `/${parentParts.join("/")}` : "__root", tag, main, staticPage, layout, segments })
  }

  const seenPaths = new Set<string>()
  const seenTags = new Set<string>()
  const dynamics = new Map<string, string>()

  for (const route of routes) {
    if (seenTags.has(route.tag)) {
      throw new Error(`Duplicate route tag: ${route.tag}`)
    }

    seenTags.add(route.tag)

    if (route.layout) {
      continue
    }

    if (seenPaths.has(route.path)) {
      throw new Error(`Duplicate route path: ${route.path}`)
    }

    seenPaths.add(route.path)

    for (const [index, segment] of route.segments.entries()) {
      if (!segment.startsWith("$")) {
        continue
      }

      const prefix = route.segments
        .slice(0, index)
        .map((part) => (part.startsWith("$") ? "$" : part))
        .join("/")

      const existing = dynamics.get(prefix)

      if (existing !== undefined && existing !== segment) {
        throw new Error(`Ambiguous dynamic siblings at ${prefix}`)
      }

      dynamics.set(prefix, segment)
    }
  }

  return routes
}

class RouteGenerationError extends Data.TaggedError("RouteGenerationError")<{ readonly message: string; readonly cause?: unknown }> {}

const generationError = (cause: unknown) => new RouteGenerationError({ message: cause instanceof Error ? cause.message : String(cause), cause })

export const readRouteInventoryEffect = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(root, "src/routes")
  const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.mapError(generationError))
  const files: string[] = []

  for (const entry of entries) {
    if (entry.type !== "File") {
      return yield* new RouteGenerationError({ message: `Unsupported route entry: ${entry.name}` })
    }

    files.push(entry.name)
  }

  const sources = yield* Effect.forEach(files, (file) =>
    fs.readFileString(path.join(directory, file)).pipe(
      Effect.map((source) => ({ file, source })),
      Effect.mapError(generationError),
    ),
  )

  return yield* Effect.try({ try: () => inventory(sources), catch: generationError })
})

export const generateFileRoutesEffect = Effect.fnUntraced(function* (root: string, check?: boolean) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const routes = yield* readRouteInventoryEffect(root)
  const source = yield* Effect.try({ try: () => renderFileRoutes(routes), catch: generationError })
  const destination = path.join(root, "src/routing/routeTree.gen.ts")
  const result = yield* Effect.tryPromise({ try: () => format(destination, source, formatOptions), catch: generationError })

  if (result.errors.length > 0) {
    return yield* new RouteGenerationError({ message: `Route formatter failed: ${result.errors.map((error) => error.message).join(", ")}` })
  }

  const current = yield* fs
    .readFileString(destination)
    .pipe(Effect.catch((error) => (error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(generationError(error)))))

  if (current === result.code) {
    return
  }

  if (check === true) {
    return yield* new RouteGenerationError({ message: "Generated route tree is stale" })
  }

  yield* fs.writeFileString(destination, result.code).pipe(Effect.mapError(generationError))
})
