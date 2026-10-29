/**
 * Release notes from the changelogs Changesets writes (docs/versioning.md): for each package a release bumps, the new
 * section of its CHANGELOG.md, gathered under the product version and prepended to the root CHANGELOG.md, which is the
 * one document of every release. Pure: prepareRelease.ts reads and writes the files.
 */

export interface ReleasedPackage {
  readonly name: string
  readonly version: string
  /** The package's CHANGELOG.md after `changeset version`. */
  readonly changelog: string
}

/** The body of the `## <version>` section, or undefined when it is missing or says only that nothing changed. */
export const sectionFor = (changelog: string, version: string): string | undefined => {
  const lines = changelog.split(/\r?\n/u)
  const start = lines.findIndex((line) => line.trim() === `## ${version}`)

  if (start === -1) {
    return undefined
  }

  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "))

  const body = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim()

  return body === "" || body === "No changes in this release." ? undefined : body
}

/** Markdown for one release: the product version, then each package's changes with headings one level down. */
export const composeReleaseNotes = (title: string, released: readonly ReleasedPackage[]): string => {
  const parts = released.flatMap((entry) => {
    const section = sectionFor(entry.changelog, entry.version)

    return section === undefined ? [] : [`### ${entry.name} ${entry.version}\n\n${section.replaceAll(/^### /gmu, "#### ")}`]
  })

  return [`## ${title}`, ...(parts.length === 0 ? ["No changes besides version numbers."] : parts)].join("\n\n")
}

const heading = "# Changelog"

const preamble = `${heading}

Every release of this repository, newest first, written from the changesets each pull request adds (docs/versioning.md). Each package also keeps its own CHANGELOG.md.`

/** The root CHANGELOG.md with `notes` as its newest entry. */
export const prependToChangelog = (existing: string | undefined, notes: string): string => {
  const rest = existing === undefined ? "" : existing.slice(existing.indexOf("\n## ") + 1)

  return `${preamble}\n\n${notes}\n${existing !== undefined && existing.includes("\n## ") ? `\n${rest}` : ""}`
}
