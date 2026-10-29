/**
 * `bun run release:prepare <notes file>`, after `changeset version` (.github/workflows/release.yml): works out which
 * packages the release bumps, writes the release notes to the given file, prepends them to the root CHANGELOG.md,
 * and prints the product version and the tags to create as GitHub Actions outputs (releaseNotes.ts,
 * docs/versioning.md). The product version is the version of the fixed group of apps, platforms and services.
 */
import { Console, Effect } from "effect"
import { composeReleaseNotes, prependToChangelog } from "./releaseNotes.ts"
import type { ReleasedPackage } from "./releaseNotes.ts"
import { changedManifests, textAtHead, textNow, writeText } from "./repository.ts"

const root = new URL("../../../", import.meta.url).pathname
const productPackage = "@file-transfer/platform-self-hosted"
const notesFile = process.argv[2]

// SAFETY: workspace manifests always carry a name and a version; nothing else is read.
const manifestOf = (text: string | undefined) => (text === undefined ? undefined : (JSON.parse(text) as { readonly name: string; readonly version: string }))

const program = Effect.gen(function* () {
  if (notesFile === undefined) {
    return yield* Effect.die(new Error("usage: bun run release:prepare <notes file>"))
  }

  const released: ReleasedPackage[] = changedManifests(root).flatMap((file) => {
    const before = manifestOf(textAtHead(root, file))
    const after = manifestOf(textNow(root, file))

    return after === undefined || before?.version === after.version
      ? []
      : [{ name: after.name, version: after.version, changelog: textNow(root, file.replace(/package\.json$/u, "CHANGELOG.md")) ?? "" }]
  })

  const product = released.find((entry) => entry.name === productPackage)
  const title = product === undefined ? "Libraries" : `v${product.version}`
  const notes = composeReleaseNotes(title, released)
  writeText(root, notesFile, `${notes}\n`)
  writeText(root, "CHANGELOG.md", prependToChangelog(textNow(root, "CHANGELOG.md"), notes))

  const tags = [...released.map((entry) => `${entry.name}@${entry.version}`), ...(product === undefined ? [] : [`v${product.version}`])]
  yield* Console.log(`version=${product?.version ?? ""}`)
  yield* Console.log(`tags=${tags.join(" ")}`)
})

await Effect.runPromise(program)
