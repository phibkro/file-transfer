import { Effect } from "effect"
import { createFileRoute } from "../routing/fileRoute.ts"

export const Route = createFileRoute("/security")({
  tag: "Security",
  staticPage: {
    view: () => Effect.promise(() => import("../site/content.ts")).pipe(Effect.map((module) => module.security)),
  },
})
