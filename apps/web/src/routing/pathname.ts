import { Predicate, Schema } from "effect"

export type PathSegment = string | { readonly name: string; readonly schema: Schema.Codec<string, string> }

export interface PathRoute<A> {
  readonly segments: readonly PathSegment[]
  readonly make: (params: Readonly<Record<string, string>>) => A
}

// This boundary accepts a pathname, never a URL containing a query or fragment.
export const matchPath = <A>(pathname: string, routes: readonly PathRoute<A>[]): A | undefined => {
  if (!pathname.startsWith("/") || pathname.includes("?") || pathname.includes("#") || pathname.includes("//")) {
    return undefined
  }

  const raw = pathname === "/" ? [] : (pathname.endsWith("/") ? pathname.slice(0, -1) : pathname).slice(1).split("/")
  let segments: string[]

  try {
    segments = raw.map(decodeURIComponent)
  } catch {
    return undefined
  }

  if (segments.some((segment) => segment === "" || segment.includes("/"))) {
    return undefined
  }

  for (const route of routes) {
    if (route.segments.length !== segments.length) {
      continue
    }

    const params: Record<string, string> = {}
    let matches = true

    for (let index = 0; index < segments.length; index++) {
      const expected = route.segments[index]
      const actual = segments[index]

      if (expected === undefined || actual === undefined) {
        matches = false
        break
      }

      if (Predicate.isString(expected)) {
        if (expected !== actual) {
          matches = false
          break
        }
      } else {
        const decoded = Schema.decodeOption(expected.schema)(actual)

        if (decoded._tag === "None") {
          matches = false
          break
        }

        params[expected.name] = decoded.value
      }
    }

    if (matches) {
      return route.make(params)
    }
  }

  return undefined
}

export const buildRoutePath = (segments: readonly PathSegment[], params: Readonly<Record<string, string>> = {}): string | undefined => {
  const names = segments.flatMap((segment) => (Predicate.isString(segment) ? [] : [segment.name]))

  if (Object.keys(params).length !== names.length || names.some((name) => !Object.hasOwn(params, name))) {
    return undefined
  }

  const encoded: string[] = []

  for (const segment of segments) {
    let value: string

    if (Predicate.isString(segment)) {
      value = segment
    } else {
      const input = params[segment.name]

      if (!Predicate.isString(input)) {
        return undefined
      }

      const result = Schema.encodeOption(segment.schema)(input)

      if (result._tag === "None") {
        return undefined
      }

      value = result.value
    }

    if (value === "" || value.includes("/")) {
      return undefined
    }

    try {
      encoded.push(encodeURIComponent(value))
    } catch {
      return undefined
    }
  }

  return `/${encoded.join("/")}`
}
