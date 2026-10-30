/** The workspace's packages and versions, as their package.json files declare them. */
import { readFileSync } from "node:fs"
import nodePath from "node:path"
import { loadWorkspace } from "ox-dep-lint"
import type { WorkspacePackage } from "./changesets.ts"

interface Manifest {
  readonly version?: string
}

// SAFETY: every package.json in this repository is a manifest; the check below reads only the field Manifest declares.
const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, "utf-8")) as Manifest

/** The `version` the package.json of the workspace at `path` (relative to `root`, "" for the root) declares. */
export const manifestVersion =
  (root: string) =>
  (path: string): string | undefined =>
    readManifest(nodePath.join(root, path, "package.json")).version

/** Every workspace package, with its name and directory: the root package.json's `workspaces`, read by ox-dep-lint. */
export const workspacePackages = (root: string): readonly WorkspacePackage[] =>
  loadWorkspace(root).packages.map((entry) => ({ name: entry.name, directory: entry.directory }))
