import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readlinkSync } from "node:fs"
import nodePath from "node:path"

/** The checked-out revision and a fingerprint of all nonignored working-tree changes. */
export const snapshot = (repository: string) => {
  const git = (...arguments_: string[]): Buffer => execFileSync("git", arguments_, { cwd: repository, stdio: ["ignore", "pipe", "ignore"] })
  const revision = git("rev-parse", "HEAD").toString("utf-8").trim()
  const hash = createHash("sha256")

  const add = (value: Uint8Array) => {
    hash.update(`${value.byteLength}:`)
    hash.update(value)
  }

  add(git("diff", "--binary", "HEAD"))
  add(git("status", "--porcelain", "-z", "--untracked-files=all"))
  const paths = git("ls-files", "--others", "--exclude-standard", "-z")
  const entries: Buffer[] = []
  let start = 0

  for (let index = 0; index < paths.length; index++) {
    if (paths[index] === 0) {
      entries.push(paths.subarray(start, index))
      start = index + 1
    }
  }

  entries.sort((left, right) => Buffer.compare(left, right))

  for (const entry of entries) {
    const path = Buffer.concat([Buffer.from(`${nodePath.resolve(repository)}${nodePath.sep}`), entry])
    const symbolicLink = lstatSync(path).isSymbolicLink()
    add(entry)
    add(Buffer.from(symbolicLink ? "link" : "file"))
    add(symbolicLink ? readlinkSync(path, { encoding: "buffer" }) : readFileSync(path))
  }

  return { revision, workingTree: hash.digest("hex") }
}
