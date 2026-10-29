/**
 * Builds the self-hosted platform: the room Worker and the web app (platforms/cloudflare's `build:all`), the assets
 * Worker, and a copy of the web app in `public`. A script rather than shell commands, so it runs the same on Windows,
 * where the release builds the Windows executable (ADR 0021).
 */
import { cpSync, mkdirSync, rmSync } from "node:fs"
import nodePath from "node:path"
import { build } from "esbuild"

const packageDirectory = nodePath.join(import.meta.dirname, "..")
const cloudflareDirectory = nodePath.join(packageDirectory, "../cloudflare")
const webDirectory = nodePath.join(packageDirectory, "../../apps/web")

const built = Bun.spawnSync(["bun", "run", "build:all"], { cwd: cloudflareDirectory, stdout: "inherit", stderr: "inherit" })

if (built.exitCode !== 0) {
  throw new Error(`platforms/cloudflare build:all exited with ${built.exitCode}`)
}

mkdirSync(nodePath.join(packageDirectory, "dist"), { recursive: true })

cpSync(nodePath.join(cloudflareDirectory, "dist/worker.js"), nodePath.join(packageDirectory, "dist/worker.js"))

await build({
  entryPoints: [nodePath.join(packageDirectory, "src/assetsWorker.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: nodePath.join(packageDirectory, "dist/assets-worker.js"),
})

rmSync(nodePath.join(packageDirectory, "public"), { recursive: true, force: true })

cpSync(nodePath.join(webDirectory, "dist"), nodePath.join(packageDirectory, "public"), { recursive: true })

console.log("built dist/worker.js, dist/assets-worker.js and public/")
