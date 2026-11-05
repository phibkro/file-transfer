import { generateFileRoutes } from "./fileRoutes.ts"

await generateFileRoutes(import.meta.dirname + "/..", true)
