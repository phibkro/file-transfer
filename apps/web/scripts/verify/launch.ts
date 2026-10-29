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
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import * as v from "valibot"

const repository = nodePath.resolve(import.meta.dirname, "../../../..")
const appDirectory = nodePath.join(repository, "apps/web")
const platformDirectory = nodePath.join(repository, "platforms/cloudflare")
const run = process.argv[2] ?? nodePath.join(tmpdir(), "verify-file-transfer", `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`)

/** The path with symbolic links resolved, as far as it exists. */
const realPathOf = (path: string): string => {
  const absolute = nodePath.resolve(path)

  return existsSync(absolute) ? realpathSync(absolute) : nodePath.join(realPathOf(nodePath.dirname(absolute)), nodePath.basename(absolute))
}

const relativeRun = nodePath.relative(realpathSync(repository), realPathOf(run))
const isOutside = relativeRun === ".." || relativeRun.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relativeRun)

if (!isOutside) {
  // Files in the checkout would count as uncommitted edits, and doctor.ts would then refuse the instance.
  console.error(`the run directory must be outside the checkout (${repository}), not ${run}`)
  process.exit(2)
}

/** Whether the run directory describes a server whose process group is still alive. */
const hasLiveServer = (): boolean => {
  try {
    const recorded: unknown = JSON.parse(readFileSync(nodePath.join(run, "server.json"), "utf-8"))
    const group = v.parse(v.object({ processIdentifier: v.number() }), recorded).processIdentifier
    process.kill(-group, 0)

    return true
  } catch {
    return false
  }
}

if (hasLiveServer()) {
  // A second launch would overwrite the first one's description, and stop.ts could no longer find that server.
  console.error(`${run} already has a server; stop it first (bun apps/web/scripts/verify/stop.ts ${run}) or use a new run directory`)
  process.exit(2)
}

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

// The instance runs from its own copy of the build: wrangler dev reloads the files it serves when they change, so an
// instance serving the checkout's build would restart (or crash) whenever a later launch rebuilds it.
// The copy keeps the platform's layout (wrangler.jsonc next to dist/worker.js), with the assets pointed at the copy.
const build = nodePath.join(run, "build")
const assetsSetting = '"directory": "../../apps/web/dist"'
const configuration = readFileSync(nodePath.join(platformDirectory, "wrangler.jsonc"), "utf-8")

if (!configuration.includes(assetsSetting)) {
  console.error(`platforms/cloudflare/wrangler.jsonc no longer has ${assetsSetting}; update launch.ts`)
  process.exit(1)
}

mkdirSync(build, { recursive: true })

cpSync(nodePath.join(platformDirectory, "dist"), nodePath.join(build, "dist"), { recursive: true })

cpSync(nodePath.join(appDirectory, "dist"), nodePath.join(build, "web"), { recursive: true })

writeFileSync(nodePath.join(build, "wrangler.jsonc"), configuration.replace(assetsSetting, '"directory": "./web"'))

const port = 20_000 + Math.floor(Math.random() * 20_000)
const origin = `http://127.0.0.1:${port}`
const log = openSync(nodePath.join(run, "server.log"), "a")

const server = spawn(
  "bunx",
  [
    "wrangler",
    "dev",
    "--config",
    nodePath.join(build, "wrangler.jsonc"),
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    String(port + 1),
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
