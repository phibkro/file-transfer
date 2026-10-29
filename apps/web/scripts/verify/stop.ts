/**
 * Stops the instance launch.ts started for a run directory (.claude/skills/verify-file-transfer): kills exactly the
 * process group recorded in `server.json`, never by name, and deletes the server's state. Evidence under
 * `<run>/evidence` stays.
 *
 *   bun apps/web/scripts/verify/stop.ts <run directory>
 */
import { readFileSync, rmSync } from "node:fs"
import nodePath from "node:path"
import * as v from "valibot"

const run = process.argv[2]

if (run === undefined) {
  console.error("usage: bun apps/web/scripts/verify/stop.ts <run directory>")
  process.exit(2)
}

const description = v.parse(v.object({ processIdentifier: v.number() }), JSON.parse(readFileSync(nodePath.join(run, "server.json"), "utf-8")))

try {
  // launch.ts starts the server detached, so its process group holds wrangler and the workerd it spawned.
  process.kill(-description.processIdentifier, "SIGTERM")
  console.log(`stopped process group ${description.processIdentifier}`)
} catch {
  console.log(`process group ${description.processIdentifier} was already gone`)
}

rmSync(nodePath.join(run, "state"), { recursive: true, force: true })

console.log(`kept evidence in ${nodePath.join(run, "evidence")}`)
