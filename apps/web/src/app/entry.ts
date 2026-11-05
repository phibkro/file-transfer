import { Effect, Redacted } from "effect"
import { Runtime } from "foldkit"
import { linkFragment, pageOrigin, pagePath, workspaceAnchor } from "./address.ts"
import { Flags, Message, Model, init, managedResources, subscriptions, update, view } from "./main.ts"
import { sweepStaleTransfers } from "../capabilities/transfer/storage.ts"
import { applicationRoute, workspaceSectionForRoute } from "./routes.ts"

const flags = Effect.gen(function* () {
  const route = applicationRoute(yield* Effect.sync(pagePath))

  const origin = yield* Effect.sync(pageOrigin)
  const fragment = route._tag === "Recipient" ? yield* Effect.sync(() => Redacted.make(linkFragment())) : Redacted.make("")

  yield* Effect.promise(sweepStaleTransfers)

  const section = workspaceSectionForRoute(route._tag)
  const initialSection = section === undefined ? "quick" : ((yield* Effect.sync(workspaceAnchor)) ?? section)

  return Flags.make({ route, fragment, initialSection, origin })
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
