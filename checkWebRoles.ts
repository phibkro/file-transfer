import { Glob } from "bun"
import config from "./effx.config.json" with { type: "json" }

// Roles must be disjoint: oxlint merges rules from overlapping groups.
const groups = config.effect.groups.map((group) => group.files.map((pattern) => new Glob(pattern)))
const files = new Glob("apps/web/src/**/*.ts")

for (const file of files.scanSync({ cwd: ".", onlyFiles: true })) {
  if (file.endsWith(".d.ts")) {
    continue
  }

  const matches = groups.filter((patterns) => patterns.some((pattern) => pattern.match(file)))

  if (matches.length !== 1) {
    throw new Error(`${file} matches ${matches.length} effx role groups, expected exactly one`)
  }
}
