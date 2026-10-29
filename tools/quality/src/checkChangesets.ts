/**
 * `bun run check:changesets`: on a pull request, fails unless it adds a changeset that names every package whose
 * shipped files it changes (changesets.ts, docs/versioning.md). Compares with `CHANGESET_BASE` (default origin/main).
 */
import { Console, Effect } from "effect"
import { parseChangeset, reviewChangesets } from "./changesets.ts"
import { addedChangesetsSince, changedFilesSince, ignoredPackages } from "./repository.ts"
import { loadWorkspace } from "./workspace.ts"

const root = new URL("../../../", import.meta.url).pathname
const base = process.env.CHANGESET_BASE ?? "origin/main"

const program = Effect.gen(function* () {
  const { packages } = loadWorkspace(root)

  const review = reviewChangesets({
    changedFiles: changedFilesSince(root, base),
    addedChangesets: addedChangesetsSince(root, base).map(({ file, text }) => parseChangeset(file, text)),
    packages,
    ignored: ignoredPackages(root),
  })

  for (const violation of review.violations) {
    yield* Console.error(violation)
  }

  for (const seam of review.seams) {
    yield* Console.log(`seam: ${seam.name} ${seam.bump}; check that this bump matches docs/versioning.md`)
  }

  yield* Console.log(`changesets: ${review.violations.length} violations against ${base}`)

  return review.violations.length
})

process.exitCode = (await Effect.runPromise(program)) === 0 ? 0 : 1
