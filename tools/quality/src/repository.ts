/** Reads what a pull request changed from git: changed files, and the changesets it adds (checkChangesets.ts). */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import nodePath from "node:path"

const git = (root: string, args: readonly string[]): string[] =>
  execFileSync("git", args, { cwd: root, encoding: "utf-8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")

/** Files changed between the merge base with `base` and the working tree's commit. */
export const changedFilesSince = (root: string, base: string): string[] => git(root, ["diff", "--name-only", `${base}...HEAD`])

/** Changeset files the branch adds, with their text. */
export const addedChangesetsSince = (root: string, base: string): { readonly file: string; readonly text: string }[] =>
  git(root, ["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", ".changeset/*.md"])
    .filter((file) => nodePath.basename(file) !== "README.md")
    .map((file) => ({ file, text: readFileSync(nodePath.join(root, file), "utf-8") }))

/** The packages `.changeset/config.json` never versions. */
export const ignoredPackages = (root: string): string[] => {
  // SAFETY: .changeset/config.json is this repository's Changesets configuration; only `ignore` is read, and checked.
  const config = JSON.parse(readFileSync(nodePath.join(root, ".changeset/config.json"), "utf-8")) as { readonly ignore?: unknown }

  return Array.isArray(config.ignore) ? config.ignore.filter((entry): entry is string => typeof entry === "string") : []
}

/** Workspace manifests changed in the working tree since the last commit, as `changeset version` leaves them. */
export const changedManifests = (root: string): string[] => git(root, ["diff", "--name-only", "HEAD", "--", "*/*/package.json"])

/** A file's text at the last commit, or undefined when it did not exist. */
export const textAtHead = (root: string, file: string): string | undefined => {
  try {
    return execFileSync("git", ["show", `HEAD:${file}`], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return undefined
  }
}

/** A file's text in the working tree, or undefined when it does not exist. */
export const textNow = (root: string, file: string): string | undefined => {
  try {
    return readFileSync(nodePath.join(root, file), "utf-8")
  } catch {
    return undefined
  }
}

/** Writes a file, relative to the repository root unless the path is absolute. */
export const writeText = (root: string, file: string, text: string) => {
  writeFileSync(nodePath.isAbsolute(file) ? file : nodePath.join(root, file), text)
}
