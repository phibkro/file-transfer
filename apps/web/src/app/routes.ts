import { Schema, pipe } from "effect"
import * as Route from "foldkit/route"

export const AppRoute = Route.defineRouteUnion({
  QuickShare: {},
  Library: {},
  Recipient: { roomIdentifier: Schema.String },
  HowItWorks: {},
  Security: {},
  Privacy: {},
  RunYourOwn: {},
  ThirdPartyNotices: {},
})

export const MainRoute = AppRoute.subset(["QuickShare", "Library", "Recipient"])
export const quickShareRouter = pipe(Route.root, Route.mapTo(AppRoute.QuickShare))
export const libraryRouter = pipe(Route.literal("library"), Route.mapTo(AppRoute.Library))
export const howItWorksRouter = pipe(Route.literal("how-it-works"), Route.mapTo(AppRoute.HowItWorks))
export const securityRouter = pipe(Route.literal("security"), Route.mapTo(AppRoute.Security))
export const privacyRouter = pipe(Route.literal("privacy"), Route.mapTo(AppRoute.Privacy))
export const runYourOwnRouter = pipe(Route.literal("run-your-own"), Route.mapTo(AppRoute.RunYourOwn))
export const thirdPartyNoticesRouter = pipe(Route.literal("pdfjs-notices.txt"), Route.mapTo(AppRoute.ThirdPartyNotices))
