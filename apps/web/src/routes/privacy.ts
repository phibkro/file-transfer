import { Effect } from "effect"
import { createFileRoute } from "../routing/fileRoute.ts"

export const Route = createFileRoute("/privacy")({
  tag: "Privacy",
  staticPage: {
    view: () => Effect.promise(() => import("../site/content.ts")).pipe(Effect.map((module) => module.privacy)),
  },
})
