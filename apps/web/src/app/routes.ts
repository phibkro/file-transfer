import { Effect, Option } from "effect"
import { AppRoute, parsePath, routeTree } from "../routing/routeTree.gen.ts"

export {
  AppRoute,
  MainRoute,
  buildPath,
  parsePath,
  routeTree,
  quickShareRouter,
  libraryRouter,
  howItWorksRouter,
  privacyRouter,
  runYourOwnRouter,
  securityRouter,
} from "../routing/routeTree.gen.ts"

export const applicationRoute = (pathname: string) =>
  parsePath(pathname).pipe(
    Effect.map((matched) => {
      if (Option.isSome(matched)) {
        const route = matched.value

        if (route._tag === "QuickShare" || route._tag === "Library" || route._tag === "Recipient") {
          return route
        }
      }

      return AppRoute.QuickShare()
    }),
  )

const workspace = routeTree.routes.find((entry) => entry.layout && entry.route.options.tag === "Workspace")

const workspaceChildren = routeTree.routes.flatMap((entry) =>
  entry.parent === workspace?.id && "workspaceSection" in entry.route.options
    ? [{ tag: entry.route.options.tag, section: entry.route.options.workspaceSection, path: entry.path }]
    : [],
)

export const workspaceSectionForRoute = (tag: string): "quick" | "library" | undefined => workspaceChildren.find((entry) => entry.tag === tag)?.section

export const workspacePathForSection = (section: "quick" | "library"): string | undefined => workspaceChildren.find((entry) => entry.section === section)?.path
