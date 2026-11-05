import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { generateFileRoutesEffect } from "./fileRoutes.ts"

await Effect.runPromise(generateFileRoutesEffect(import.meta.dirname.concat("/.."), !process.argv.includes("--write")).pipe(Effect.provide(NodeServices.layer)))
