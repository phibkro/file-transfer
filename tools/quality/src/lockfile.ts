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
