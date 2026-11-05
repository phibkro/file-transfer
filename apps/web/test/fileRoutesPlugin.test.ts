import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer } from "vite-plus"
import { expect, it } from "vite-plus/test"
import { fileRoutes } from "../scripts/fileRoutesPlugin.ts"

it("blocks HTML while route declarations are invalid and recovers after real file changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "file-route-watcher-"))
  await mkdir(path.join(root, "src/routes"), { recursive: true })
  await mkdir(path.join(root, "src/routing"), { recursive: true })
  await writeFile(path.join(root, "src/routes/__root.ts"), "export const Route = createRootRoute({})")
  await writeFile(path.join(root, "src/routes/index.ts"), 'export const Route = createFileRoute("/")({ tag: "Home", main: true })')
  await writeFile(path.join(root, "index.html"), "<!doctype html><html><head><title>Watcher</title></head><body><h1>Route watcher</h1></body></html>")

  const server = await createServer({ configFile: false, root, logLevel: "silent", plugins: [fileRoutes()], server: { host: "127.0.0.1", port: 0 } })

  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]

    if (origin === undefined) {
      throw new Error("Vite did not expose its listening address")
    }

    const responseStatus = async () => {
      const response = await fetch(origin, { headers: { accept: "text/html" } })

      return response.status
    }

    expect(await responseStatus()).toBe(200)

    const extra = path.join(root, "src/routes/extra.ts")
    await writeFile(extra, 'export const Route = createFileRoute("/wrong-name")({ tag: "Extra", main: true })')
    await expect.poll(responseStatus, { timeout: 10_000 }).toBe(503)
    const invalidResponse = await fetch(origin, { headers: { accept: "text/html" } })

    expect(await invalidResponse.text()).toContain("Route generation is incomplete")

    await writeFile(extra, 'export const Route = createFileRoute("/extra")({ tag: "Extra", main: true })')
    await expect.poll(responseStatus, { timeout: 10_000 }).toBe(200)

    await writeFile(extra, "invalid TypeScript route {")
    await expect.poll(responseStatus, { timeout: 10_000 }).toBe(503)
    await rm(extra)
    await expect.poll(responseStatus, { timeout: 10_000 }).toBe(200)
    const recoveredResponse = await fetch(origin)

    expect(await recoveredResponse.text()).toContain("<h1>Route watcher</h1>")
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
