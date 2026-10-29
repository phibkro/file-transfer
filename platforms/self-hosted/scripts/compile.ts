/**
 * Compiles `dist/node.capnp` (scripts/nodeConfig.ts) into one executable with this platform's workerd, as
 * `dist/file-transfer-node` (`.exe` on Windows). `workerd compile` attaches the configuration to the workerd binary
 * that runs it, so each platform's executable is compiled on that platform (ADR 0021).
 */
import { chmodSync } from "node:fs"
import nodePath from "node:path"
import workerdPath from "workerd"

const packageDirectory = nodePath.join(import.meta.dirname, "..")
const output = nodePath.join(packageDirectory, "dist", process.platform === "win32" ? "file-transfer-node.exe" : "file-transfer-node")

const compiled = Bun.spawnSync([workerdPath, "compile", "node.capnp"], {
  cwd: nodePath.join(packageDirectory, "dist"),
  stdout: Bun.file(output),
  stderr: "inherit",
})

if (compiled.exitCode !== 0) {
  throw new Error(`workerd compile exited with ${compiled.exitCode}`)
}

chmodSync(output, 0o755)
console.log(`wrote ${nodePath.relative(packageDirectory, output)}`)
