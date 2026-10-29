/**
 * The changelog rule every pull request meets (docs/versioning.md, docs/decisions/0023): it adds at least one
 * changeset, and every package whose shipped files it changes is named in one, with a semantic version bump. A pull
 * request that ships nothing (documentation, tests, CI) adds an empty changeset, so skipping one is a decision written
 * down, not an oversight. Pure: the caller reads git and the files (checkChangesets.ts).
 */

export type Bump = "major" | "minor" | "patch"

export interface Release {
  readonly name: string
  readonly bump: Bump
}

export interface Changeset {
  /** Path relative to the repository root, such as `.changeset/quick-foxes-jump.md`. */
  readonly file: string
  readonly releases: readonly Release[]
  readonly summary: string
}

export interface WorkspacePackage {
  readonly name: string
  /** Path relative to the repository root, such as `libraries/parcel`. */
  readonly directory: string
}

/**
 * Packages whose versions describe a contract between independently built pieces (docs/versioning.md): the parcel
 * format, the room protocol, and the server's HTTP API, settings and Durable Object classes. Their bumps are listed
 * for review, because the code cannot tell whether a change is compatible.
 */
export const seamPackages: readonly string[] = ["@file-transfer/parcel", "@file-transfer/transport", "@file-transfer/platform-cloudflare"]

const bumps: ReadonlySet<string> = new Set(["major", "minor", "patch"])

/** Parses one changeset file: `---`, lines of `"package": bump`, `---`, then the summary. */
export const parseChangeset = (file: string, text: string): Changeset | string => {
  const match = /^---\r?\n(?<frontmatter>[\s\S]*?)^---\r?\n?(?<summary>[\s\S]*)$/mu.exec(text)

  if (match?.groups === undefined) {
    return `${file}: not a changeset (it must start with --- and a list of packages, then ---)`
  }

  const releases: Release[] = []

  for (const line of (match.groups.frontmatter ?? "").split(/\r?\n/u)) {
    if (line.trim() === "") {
      continue
    }

    const entry = /^\s*["']?(?<name>[^"':\s]+)["']?\s*:\s*(?<bump>\w+)\s*$/u.exec(line)
    const name = entry?.groups?.name
    const bump = entry?.groups?.bump

    if (name === undefined || bump === undefined || !bumps.has(bump)) {
      return `${file}: "${line.trim()}" is not "package": major, minor or patch`
    }

    // SAFETY: bump was just checked to be a member of `bumps`, which holds exactly the Bump values.
    releases.push({ name, bump: bump as Bump })
  }

  return { file, releases, summary: (match.groups.summary ?? "").trim() }
}

/** Files that ship with a package: everything except tests, development scripts and generated changelogs. */
export const isShippedFile = (pathInPackage: string): boolean =>
  !(
    pathInPackage.startsWith("test/") ||
    pathInPackage.startsWith("scripts/") ||
    pathInPackage.endsWith(".test.ts") ||
    pathInPackage === "README.md" ||
    pathInPackage === "CHANGELOG.md"
  )

/** The package a changed file belongs to, when it is a shipped file of one. */
export const shippedPackageOf = (file: string, packages: readonly WorkspacePackage[]): string | undefined => {
  const owner = packages.find((candidate) => file.startsWith(`${candidate.directory}/`))

  return owner !== undefined && isShippedFile(file.slice(owner.directory.length + 1)) ? owner.name : undefined
}

export interface ChangesetReview {
  readonly violations: readonly string[]
  /** Seam packages this pull request releases, with the bump it declares, for the reviewer to judge. */
  readonly seams: readonly Release[]
}

export const reviewChangesets = (options: {
  readonly changedFiles: readonly string[]
  readonly addedChangesets: readonly (Changeset | string)[]
  readonly packages: readonly WorkspacePackage[]
  /** Packages that are never versioned (repository tools). */
  readonly ignored: readonly string[]
}): ChangesetReview => {
  const violations: string[] = []
  const parsed = options.addedChangesets.filter((changeset): changeset is Changeset => typeof changeset !== "string")
  const known = new Set(options.packages.map((candidate) => candidate.name))
  const ignored = new Set(options.ignored)

  violations.push(...options.addedChangesets.filter((changeset): changeset is string => typeof changeset === "string"))

  if (options.addedChangesets.length === 0) {
    violations.push(
      "this pull request adds no changeset: run `bunx changeset` and pick a bump for each package you changed, or `bunx changeset --empty` if it ships nothing",
    )
  }

  for (const changeset of parsed) {
    if (changeset.summary === "") {
      violations.push(`${changeset.file}: says nothing; describe the change for the changelog`)
    }

    for (const release of changeset.releases) {
      if (!known.has(release.name)) {
        violations.push(`${changeset.file}: names ${release.name}, which is not a package in this repository`)
      } else if (ignored.has(release.name)) {
        violations.push(`${changeset.file}: names ${release.name}, which is never versioned`)
      }
    }
  }

  const released = new Set(parsed.flatMap((changeset) => changeset.releases.map((release) => release.name)))
  const changed = new Set(options.changedFiles.flatMap((file) => shippedPackageOf(file, options.packages) ?? []))

  for (const name of [...changed].toSorted()) {
    if (!ignored.has(name) && !released.has(name)) {
      violations.push(`${name} changed, but no changeset names it: add it with the bump its users need (docs/versioning.md)`)
    }
  }

  const strongest = new Map<string, Release>()
  const order: readonly Bump[] = ["patch", "minor", "major"]

  for (const release of parsed.flatMap((changeset) => changeset.releases)) {
    const current = strongest.get(release.name)

    if (seamPackages.includes(release.name) && (current === undefined || order.indexOf(release.bump) > order.indexOf(current.bump))) {
      strongest.set(release.name, release)
    }
  }

  return { violations, seams: [...strongest.values()] }
}
