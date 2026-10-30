/**
 * Whether bun.lock records the version each workspace's package.json declares. `changeset version` bumps the manifests
 * but not the lockfile, so without the release step's refresh every install after a release rewrites bun.lock, and
 * `bun install --frozen-lockfile` does not notice (it ignores workspace versions).
 */

interface LockedWorkspace {
  readonly name?: string
  readonly version?: string
}

/** bun.lock is JSON with trailing commas, which JSON.parse rejects. No string in it ends in a comma before a bracket. */
const withoutTrailingCommas = (text: string): string => text.replaceAll(/,(?=\s*[}\]])/gu, "")

/** The workspaces bun.lock records, by path relative to the root (the root itself is ""). */
export const lockedWorkspaces = (lockText: string): ReadonlyMap<string, LockedWorkspace> => {
  // SAFETY: bun.lock's `workspaces` maps each workspace path to an object; only `name` and `version` are read.
  const lock = JSON.parse(withoutTrailingCommas(lockText)) as { readonly workspaces?: Readonly<Record<string, LockedWorkspace>> }

  return new Map(Object.entries(lock.workspaces ?? {}))
}

/** One line per workspace whose locked version differs from its manifest's; empty when they agree. */
export const lockfileDrift = (lockText: string, manifestVersion: (path: string) => string | undefined): string[] =>
  [...lockedWorkspaces(lockText)].flatMap(([path, locked]) => {
    const declared = manifestVersion(path)

    return locked.version === declared
      ? []
      : [`${path || "(root)"}: bun.lock has ${locked.version ?? "no version"}, package.json has ${declared ?? "no version"}`]
  })

/** `@effect/tsgo` and its platform binaries follow their own release line, not Effect's. */
const ownReleaseLine = /^@effect\/tsgo(?:-|$)/u

interface ResolvedPackage {
  readonly name: string
  readonly version: string
}

/** The packages bun.lock resolves, from each entry's first field (`name@version`); workspace links included. */
const resolvedPackages = (lockText: string): ResolvedPackage[] => {
  // SAFETY: bun.lock's `packages` maps each install path to an array whose first field is the `name@version` it resolves.
  const lock = JSON.parse(withoutTrailingCommas(lockText)) as {
    readonly packages?: Readonly<Record<string, readonly [identifier: string, ...details: unknown[]]>>
  }

  return Object.values(lock.packages ?? {}).flatMap(([identifier]) => {
    const separator = identifier.lastIndexOf("@")

    return separator > 0 ? [{ name: identifier.slice(0, separator), version: identifier.slice(separator + 1) }] : []
  })
}

/**
 * One line per `@effect/*` package that bun.lock resolves at another version than `effect`, or one line when `effect`
 * itself is locked at no version or several; empty when the family agrees. An `@effect` package at another version than
 * `effect` fails when it loads, not at type check, and Alchemy pulls `@effect/platform-node-shared` and `@effect/sql-d1`
 * in at `^4.0.5`, so the root package.json pins them to the effect version with `overrides`.
 */
export const effectFamilyDrift = (lockText: string): string[] => {
  const family = resolvedPackages(lockText).filter(({ name }) => (name === "effect" || name.startsWith("@effect/")) && !ownReleaseLine.test(name))
  const effectVersions = [...new Set(family.filter(({ name }) => name === "effect").map(({ version }) => version))].toSorted()
  const [effectVersion] = effectVersions

  if (effectVersion === undefined || effectVersions.length > 1) {
    return [`effect: bun.lock has ${effectVersions.length === 0 ? "no version" : effectVersions.join(", ")}`]
  }

  const drifted = new Set(family.filter(({ version }) => version !== effectVersion).map(({ name, version }) => `${name}@${version}`))

  return [...drifted].toSorted().map((identifier) => `${identifier}: bun.lock has effect@${effectVersion}`)
}
