/**
 * Starts a disposable local instance for verification (.claude/skills/verify-file-transfer): builds apps/web and
 * platforms/cloudflare, starts `wrangler dev` with its state under a fresh run directory, waits until the app and its
 * API answer, and writes `server.json` (origin, process, revision) into the run directory for doctor.ts, drive.ts and
 * stop.ts. Prints the run directory and origin as one JSON line.
 *
 *   bun apps/web/scripts/verify/launch.ts [run directory]
 */
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, openSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"

const repository = nodePath.resolve(import.meta.dirname, "../../../..")
const appDirectory = nodePath.join(repository, "apps/web")
const platformDirectory = nodePath.join(repository, "platforms/cloudflare")
const run = process.argv[2] ?? nodePath.join(tmpdir(), "verify-file-transfer", `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`)

mkdirSync(run, { recursive: true })

const environment = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", WRANGLER_SEND_METRICS: "false" }

for (const [label, directory] of [
  ["app", appDirectory],
  ["platform", platformDirectory],
] as const) {
  const build = spawnSync("bun", ["run", "build"], { cwd: directory, env: environment, encoding: "utf-8" })

  if (build.status !== 0) {
    console.error(`${label} build failed:\n${build.stderr}`)
    process.exit(1)
  }
}

const port = 20_000 + Math.floor(Math.random() * 20_000)
const origin = `http://127.0.0.1:${port}`
const log = openSync(nodePath.join(run, "server.log"), "a")

const server = spawn(
  "bunx",
  [
    "wrangler",
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    String(port + 1),
    "--assets",
    nodePath.join(appDirectory, "dist"),
    "--persist-to",
    nodePath.join(run, "state"),
    "--show-interactive-dev-session=false",
    "--log-level",
    "warn",
  ],
  { cwd: platformDirectory, env: environment, stdio: ["ignore", log, log], detached: true },
)

server.unref()

const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf-8" }).stdout.trim()

/** Ready means usable: the page is the app, and the API that a sender calls first answers with JSON. */
const isReady = async (): Promise<boolean> => {
  try {
    const page = await fetch(`${origin}/`)
    const limits = await fetch(`${origin}/api/limits`)

    const body = await page.text()
    const type = limits.headers.get("content-type") ?? ""

    return page.ok && body.includes("<title>File transfer</title>") && limits.ok && type.includes("json")
  } catch {
    return false
  }
}

for (let attempt = 0; attempt < 120; attempt++) {
  if (await isReady()) {
    const description = { run, origin, processIdentifier: server.pid, revision, startedAt: new Date().toISOString() }
    writeFileSync(nodePath.join(run, "server.json"), `${JSON.stringify(description, undefined, 2)}\n`)
    console.log(JSON.stringify({ run, origin }))
    process.exit(0)
  }

  await Bun.sleep(500)
}

if (server.pid !== undefined) {
  process.kill(-server.pid)
}

console.error(`wrangler dev did not become ready within 60 s; see ${nodePath.join(run, "server.log")}`)

process.exit(1)
