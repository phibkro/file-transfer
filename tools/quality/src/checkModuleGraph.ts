/** `bun run check:graph`: prints every module graph violation and fails if there are any. */
import { Console, Effect } from "effect"
import { checkModuleGraph, describeViolation } from "./moduleGraph.ts"
import { loadWorkspace } from "./workspace.ts"

const root = new URL("../../../", import.meta.url).pathname

const program = Effect.gen(function* () {
  const { packages, rootDevelopmentDependencies } = loadWorkspace(root)
  const violations = checkModuleGraph(packages, rootDevelopmentDependencies)

  for (const violation of violations) {
    yield* Console.error(describeViolation(violation))
  }

  const importCount = packages.reduce((sum, facts) => sum + facts.imports.length, 0)
  yield* Console.log(`module graph: ${packages.length} packages, ${importCount} imports, ${violations.length} violations`)

  return violations.length
})

process.exitCode = (await Effect.runPromise(program)) === 0 ? 0 : 1
