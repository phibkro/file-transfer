import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { snapshot } from "../scripts/verify/snapshot.ts"

describe("verification working-tree snapshot", () => {
  it("tracks real changes without following untracked links or including ignored files", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "verify-snapshot-"))
    const repository = nodePath.join(root, "repo")
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, stdio: "ignore" })

    try {
      execFileSync("git", ["init", "-q", repository])
      writeFileSync(nodePath.join(repository, ".gitignore"), "ignored\n")
      writeFileSync(nodePath.join(repository, "tracked"), "initial")
      git("add", ".")
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "initial")
      const clean = snapshot(repository)
      expect(snapshot(repository)).toEqual(clean)
      writeFileSync(nodePath.join(repository, "tracked"), "edited")
      const tracked = snapshot(repository)
      expect(tracked.workingTree).not.toBe(clean.workingTree)
      const file = nodePath.join(repository, "new file")
      writeFileSync(file, "first")
      const added = snapshot(repository)
      writeFileSync(file, "other")
      const edited = snapshot(repository)
      expect(edited.workingTree).not.toBe(added.workingTree)
      renameSync(file, nodePath.join(repository, "renamed"))
      const renamed = snapshot(repository)
      expect(renamed.workingTree).not.toBe(edited.workingTree)
      writeFileSync(nodePath.join(repository, "ignored"), "first")
      writeFileSync(nodePath.join(repository, "ignored"), "second")
      expect(snapshot(repository)).toEqual(renamed)
      const outside = nodePath.join(root, "outside")
      const link = nodePath.join(repository, "link")
      writeFileSync(outside, "first")
      symlinkSync(outside, link)
      const linked = snapshot(repository)
      writeFileSync(outside, "second")
      expect(snapshot(repository)).toEqual(linked)
      unlinkSync(link)
      symlinkSync(`${outside}-other`, link)
      expect(snapshot(repository).workingTree).not.toBe(linked.workingTree)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails when git cannot read a repository", () => {
    const directory = mkdtempSync(nodePath.join(tmpdir(), "verify-no-git-"))

    try {
      expect(() => snapshot(directory)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("verification launcher", () => {
  it("refuses to start a server when source changes during a build", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "verify-launch-"))
    const repository = nodePath.join(root, "repo")
    const run = nodePath.join(root, "run")
    const app = nodePath.join(repository, "apps/web")
    const platform = nodePath.join(repository, "platforms/cloudflare")
    const scripts = nodePath.join(app, "scripts/verify")
    const bin = nodePath.join(root, "bin")
    const marker = nodePath.join(root, "bunx-called")
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, stdio: "ignore" })

    try {
      mkdirSync(scripts, { recursive: true })
      mkdirSync(platform, { recursive: true })
      mkdirSync(bin)

      for (const name of ["launch.ts", "snapshot.ts"]) {
        copyFileSync(nodePath.join(import.meta.dirname, "../scripts/verify", name), nodePath.join(scripts, name))
      }

      symlinkSync(nodePath.resolve(import.meta.dirname, "../node_modules"), nodePath.join(app, "node_modules"))
      writeFileSync(nodePath.join(repository, ".gitignore"), "node_modules\ndist\n")
      writeFileSync(nodePath.join(app, "package.json"), JSON.stringify({ scripts: { build: "bun build-fixture.js" } }))
      writeFileSync(nodePath.join(app, "source.txt"), "old source")
      writeFileSync(
        nodePath.join(app, "build-fixture.js"),
        'const fs = require("node:fs"); fs.mkdirSync("dist"); fs.copyFileSync("source.txt", "dist/asset.txt"); fs.writeFileSync("source.txt", "new source");',
      )
      writeFileSync(nodePath.join(platform, "package.json"), JSON.stringify({ scripts: { build: "bun build-fixture.js" } }))
      writeFileSync(
        nodePath.join(platform, "build-fixture.js"),
        'const fs = require("node:fs"); fs.mkdirSync("dist"); fs.writeFileSync("dist/worker.js", "worker");',
      )
      writeFileSync(nodePath.join(platform, "wrangler.jsonc"), '{ "assets": { "directory": "../../apps/web/dist" } }')
      writeFileSync(nodePath.join(bin, "bunx"), '#!/bin/sh\nprintf called > "$VERIFY_BUNX_MARKER"\n', { mode: 0o755 })
      execFileSync("git", ["init", "-q", repository])
      git("add", ".")
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "initial")

      const result = spawnSync("bun", [nodePath.join(scripts, "launch.ts"), run], {
        cwd: repository,
        env: { ...process.env, PATH: `${bin}${nodePath.delimiter}${process.env.PATH ?? ""}`, VERIFY_BUNX_MARKER: marker },
        encoding: "utf-8",
        timeout: 10_000,
      })

      expect(result.status).toBe(1)
      expect(readFileSync(nodePath.join(run, "build/web/asset.txt"), "utf-8")).toBe("old source")
      expect(readFileSync(nodePath.join(app, "source.txt"), "utf-8")).toBe("new source")
      expect(existsSync(nodePath.join(run, "server.json"))).toBe(false)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
