import type { Schema } from "effect"

type ParametersInPath<Path extends string> = Path extends `${string}$${infer Rest}`
  ? Rest extends `${infer Name}/${infer Tail}` ? Name | ParametersInPath<Tail> : Rest
  : never

type RouteOptions<Path extends string> = {
  readonly tag: string
  readonly main?: boolean
} & ([ParametersInPath<Path>] extends [never]
  ? { readonly params?: never }
  : { readonly params: { readonly [Key in ParametersInPath<Path>]: Schema.Codec<string, string> } })

export const createRootRoute = <const Options extends object>(options: Options) => ({ id: "__root" as const, options })
export const createFileRoute = <const Path extends string>(id: Path) =>
  <const Options extends RouteOptions<Path>>(options: Options) => ({ id, options })
