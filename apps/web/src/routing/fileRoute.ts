import type { Effect, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { FileRouteId } from "./routeTree.gen.ts"

type ParametersInPath<Path extends string> = Path extends `${string}$${infer Rest}`
  ? Rest extends `${infer Name}/${infer Tail}`
    ? Name | ParametersInPath<Tail>
    : Rest
  : never

interface StaticPage {
  readonly view: () => Effect.Effect<(h: HtmlBuilder<never>) => Html>
}

type RouteOptions<Path extends string> = { readonly tag: string } & (
  | { readonly main?: false; readonly staticPage?: StaticPage; readonly workspaceSection?: never }
  | { readonly main: true; readonly staticPage?: never; readonly workspaceSection?: Path extends `/_workspace/${string}` ? "quick" | "library" : never }
) &
  ([ParametersInPath<Path>] extends [never]
    ? { readonly params?: never }
    : { readonly params: { readonly [Key in ParametersInPath<Path>]: Schema.Codec<string, string> }; readonly staticPage?: never })

export const createRootRoute = <const Options extends Record<keyof Options, never>>(options: Options) => ({ id: "__root" as const, options })

export const createFileRoute =
  <const Path extends FileRouteId>(id: Path) =>
  <const Options extends RouteOptions<Path>>(
    options: Options &
      Record<Exclude<keyof Options, keyof RouteOptions<Path>>, never> &
      (Options extends { readonly params: infer Params }
        ? { readonly params: Params & Record<Exclude<keyof Params, ParametersInPath<Path>>, never> }
        : unknown),
  ) => ({ id, options })
