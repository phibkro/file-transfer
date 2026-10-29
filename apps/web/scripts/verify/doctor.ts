/**
 * Read-only check that an instance is worth driving (.claude/skills/verify-file-transfer). Given a run directory from
 * launch.ts it also checks that the server process is ours and alive and that it serves the revision checked out now;
 * given a URL (a pull request preview, say) it checks only what the URL answers. Prints one line per check and exits
 * non-zero when any fails.
 *
 *   bun apps/web/scripts/verify/doctor.ts <run directory | https://...>
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import nodePath from "node:path"
import * as v from "valibot"

const ServerDescription = v.object({ run: v.string(), origin: v.string(), processIdentifier: v.number(), revision: v.string() })

const target = process.argv[2]

if (target === undefined) {
  console.error("usage: bun apps/web/scripts/verify/doctor.ts <run directory | https://...>")
  process.exit(2)
}

const results: { readonly check: string; readonly ok: boolean; readonly detail: string }[] = []
const record = (check: string, ok: boolean, detail: string) => results.push({ check, ok, detail })

let origin = target

if (!/^https?:\/\//u.test(target)) {
  const description = v.parse(ServerDescription, JSON.parse(readFileSync(nodePath.join(target, "server.json"), "utf-8")))

  ;({ origin } = description)
  let alive = true

  try {
    process.kill(description.processIdentifier, 0)
  } catch {
    alive = false
  }

  record("server process started by this run is alive", alive, `process ${description.processIdentifier}`)
  const repository = nodePath.resolve(import.meta.dirname, "../../../..")
  const checkedOut = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf-8" }).stdout.trim()
  record(
    "instance was built from the revision checked out now",
    checkedOut === description.revision,
    `built ${description.revision.slice(0, 12)}, checked out ${checkedOut.slice(0, 12)}`,
  )
}

try {
  const page = await fetch(`${origin}/`)
  const body = await page.text()
  record("the origin serves the app", page.ok && body.includes("<title>File transfer</title>"), `${origin}/ answered ${page.status}`)
} catch (error) {
  record("the origin serves the app", false, String(error))
}

try {
  const limits = await fetch(`${origin}/api/limits`)
  record("the API answers /api/limits with JSON", limits.ok && (limits.headers.get("content-type") ?? "").includes("json"), `answered ${limits.status}`)
} catch (error) {
  record("the API answers /api/limits with JSON", false, String(error))
}

for (const result of results) {
  console.log(`${result.ok ? "ok" : "NOT OK"} ${result.check} (${result.detail})`)
}

process.exit(results.every((result) => result.ok) ? 0 : 1)
