import { Effect, Redacted } from "effect"
import { Runtime } from "foldkit"
import { linkFragment, pageOrigin, pagePath, workspaceAnchor } from "./address.ts"
import { Flags, Message, Model, init, managedResources, subscriptions, update, view } from "./main.ts"
import { sweepStaleTransfers } from "./storage.ts"
import { AppRoute, libraryRouter } from "./routes.ts"

const flags = Effect.gen(function* () {
  const path = yield* Effect.sync(pagePath)
  const origin = yield* Effect.sync(pageOrigin)
  const recipient = /^\/r\/(?<roomIdentifier>[A-Za-z0-9_-]{22})\/?$/u.exec(path)
  const roomIdentifier = recipient?.groups?.roomIdentifier
  const fragment = roomIdentifier === undefined ? Redacted.make("") : yield* Effect.sync(() => Redacted.make(linkFragment()))

  yield* Effect.promise(sweepStaleTransfers)

  if (roomIdentifier !== undefined) {
    return Flags.make({ route: AppRoute.Recipient({ roomIdentifier }), fragment, initialSection: "quick", origin })
  }

  const initialSection = (yield* Effect.sync(workspaceAnchor)) ?? (path === libraryRouter() || path === `${libraryRouter()}/` ? "library" : "quick")

  return Flags.make({
    route: path === libraryRouter() || path === `${libraryRouter()}/` ? AppRoute.Library() : AppRoute.QuickShare(),
    fragment,
    initialSection,
    origin,
  })
})

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions,
  managedResources,
  container: document.querySelector("#app"),
  devTools: { Message },
})

Runtime.run(application, { flags })
