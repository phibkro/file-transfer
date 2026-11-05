import { Effect, Option, Predicate, Schema } from "effect"
import type * as Route from "foldkit/route"

export type PathSegment = string | { readonly name: string; readonly schema: Schema.Codec<string, string> }

// Only a pathname crosses this boundary, never a query or fragment.
export const parsePathname = <A>(pathname: string, router: Route.Parser<A>): Effect.Effect<Option.Option<A>> => {
  if (!pathname.startsWith("/") || pathname.includes("?") || pathname.includes("#") || pathname.includes("//")) {
    return Effect.succeedNone
  }

  const raw = pathname === "/" ? [] : (pathname.endsWith("/") ? pathname.slice(0, -1) : pathname).slice(1).split("/")
  let segments: string[]

  try {
    segments = raw.map(decodeURIComponent)
  } catch {
    return Effect.succeedNone
  }

  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("/"))) {
    return Effect.succeedNone
  }

  return router.parse(segments).pipe(Effect.option, Effect.map(Option.map(([value]) => value)))
}

// Foldkit's callable printer returns raw joined segments and throws on invalid input.
// Validate its segment boundary before calling it, then encode the printed segments.
export const buildRoutePath = (
  segments: readonly PathSegment[],
  params: Readonly<Record<string, string>> | undefined,
  print: (params: Readonly<Record<string, string>>) => string | undefined,
): string | undefined => {
  const values = params ?? {}
  const names = segments.flatMap((segment) => (Predicate.isString(segment) ? [] : [segment.name]))

  if (Object.keys(values).length !== names.length || names.some((name) => !Object.hasOwn(values, name))) {
    return undefined
  }

  for (const segment of segments) {
    if (Predicate.isString(segment)) {
      continue
    }

    const input = values[segment.name]

    if (!Predicate.isString(input)) {
      return undefined
    }

    const result = Schema.encodeOption(segment.schema)(input)

    if (result._tag === "None" || result.value === "" || result.value === "." || result.value === ".." || result.value.includes("/")) {
      return undefined
    }
  }

  try {
    const printed = print(values)

    if (printed === undefined) {
      return undefined
    }

    const parts = printed.split("/")

    if (parts.some((part) => part === "." || part === "..")) {
      return undefined
    }

    return parts.map(encodeURIComponent).join("/")
  } catch {
    return undefined
  }
}
