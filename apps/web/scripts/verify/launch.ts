/**
 * Starts a disposable local instance for verification (.claude/skills/verify-file-transfer): builds apps/web and
 * platforms/cloudflare, starts `wrangler dev` with its state under a fresh run directory, waits until the app and its
 * API answer. It writes `server.json` (origin, process group, revision, working tree, `ready`) into the run directory
 * as soon as the server process exists, so stop.ts can clean up even after an interrupted or failed launch, and sets
 * `ready` once the server is usable. Prints the run directory and origin as one JSON line.
 *
 *   bun apps/web/scripts/verify/launch.ts [run directory]
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
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

const git = (...arguments_: string[]) => spawnSync("git", arguments_, { cwd: repository, encoding: "utf-8" }).stdout
const revision = git("rev-parse", "HEAD").trim()

// Uncommitted edits are built too, so the instance is described by the revision plus a digest of the working tree's
// difference from it (doctor.ts recomputes both).
const workingTree = createHash("sha256")
  .update(git("diff", "HEAD"))
  .update(git("status", "--porcelain", "--untracked-files=all"))
  .digest("hex")

const describe = (ready: boolean) => {
  const description = { run, origin, processIdentifier: server.pid, revision, workingTree, ready, startedAt: new Date().toISOString() }
  writeFileSync(nodePath.join(run, "server.json"), `${JSON.stringify(description, undefined, 2)}\n`)
}

describe(false)

/** Kills the server's whole process group (wrangler and the workerd it started) and exits. */
const abandon = (message: string) => {
  if (server.pid !== undefined) {
    try {
      process.kill(-server.pid)
    } catch {
      // Already gone.
    }
  }

  console.error(message)
  process.exit(1)
}

process.on("SIGINT", () => {
  abandon("launch interrupted; the server it started was stopped")
})

process.on("SIGTERM", () => {
  abandon("launch terminated; the server it started was stopped")
})

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
    describe(true)
    console.log(JSON.stringify({ run, origin }))
    process.exit(0)
  }

  await Bun.sleep(500)
}

abandon(`wrangler dev did not become ready within 60 s; see ${nodePath.join(run, "server.log")}`)
