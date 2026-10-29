/**
 * `bun run release:notes <tag> <notes file>`, in .github/workflows/publish.yml: writes the notes of the release `tag`
 * (for example v0.2.0) to the given file, read back from its section of the root CHANGELOG.md, which
 * prepareRelease.ts wrote when the release was versioned (releaseNotes.ts, docs/versioning.md).
 */
import { Effect } from "effect"
import { sectionFor } from "./releaseNotes.ts"
import { textNow, writeText } from "./repository.ts"

const root = new URL("../../../", import.meta.url).pathname
const [tag, notesFile] = process.argv.slice(2)

const program = Effect.gen(function* () {
  if (tag === undefined || notesFile === undefined) {
    return yield* Effect.die(new Error("usage: bun run release:notes <tag> <notes file>"))
  }

  const changelog = textNow(root, "CHANGELOG.md")

  if (changelog?.includes(`\n## ${tag}\n`) !== true) {
    return yield* Effect.die(new Error(`CHANGELOG.md has no section for ${tag}`))
  }

  writeText(root, notesFile, `${sectionFor(changelog, tag) ?? "No changes besides version numbers."}\n`)
})

await Effect.runPromise(program)
