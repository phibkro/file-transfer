import { Effect } from "effect"
import { createFileRoute } from "../routing/fileRoute.ts"

export const Route = createFileRoute("/run-your-own")({
  tag: "RunYourOwn",
  staticPage: {
    view: () => Effect.promise(() => import("../site/content.ts")).pipe(Effect.map((module) => module.runYourOwn)),
  },
})
