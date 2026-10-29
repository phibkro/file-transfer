/**
 * Stops the instance launch.ts started for a run directory (.claude/skills/verify-file-transfer): kills exactly the
 * process group recorded in `server.json`, never by name, and deletes the server's state. Evidence under
 * `<run>/evidence` stays.
 *
 *   bun apps/web/scripts/verify/stop.ts <run directory>
 */
import { existsSync, readFileSync, rmSync } from "node:fs"
import nodePath from "node:path"
import * as v from "valibot"

const run = process.argv[2]

if (run === undefined) {
  console.error("usage: bun apps/web/scripts/verify/stop.ts <run directory>")
  process.exit(2)
}

const descriptionFile = nodePath.join(run, "server.json")

if (!existsSync(descriptionFile)) {
  // launch.ts writes it as soon as the server process exists, so without it no server was started.
  console.log(`nothing to stop: ${descriptionFile} does not exist`)
  process.exit(0)
}

const description = v.parse(v.object({ processIdentifier: v.number() }), JSON.parse(readFileSync(descriptionFile, "utf-8")))

/** Whether any process of the group is still alive. */
const groupAlive = (group: number): boolean => {
  try {
    process.kill(-group, 0)

    return true
  } catch {
    return false
  }
}

// launch.ts starts the server detached, so its process group holds wrangler and the workerd it spawned.
const group = description.processIdentifier

if (groupAlive(group)) {
  process.kill(-group, "SIGTERM")

  for (let waited = 0; waited < 10_000 && groupAlive(group); waited += 250) {
    await Bun.sleep(250)
  }

  if (groupAlive(group)) {
    process.kill(-group, "SIGKILL")
    await Bun.sleep(250)
  }

  console.log(groupAlive(group) ? `process group ${group} is still running` : `stopped process group ${group}`)
} else {
  console.log(`process group ${group} was already gone`)
}

rmSync(nodePath.join(run, "state"), { recursive: true, force: true })

console.log(`kept evidence in ${nodePath.join(run, "evidence")}`)
