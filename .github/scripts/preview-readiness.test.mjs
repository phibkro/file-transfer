import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./preview-readiness.mjs", import.meta.url))

async function probe(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const directory = await mkdtemp(join(tmpdir(), "preview-probe-"))
  const output = join(directory, "output")
  try {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, PREVIEW_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_OUTPUT: output },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let log = ""
    child.stdout.on("data", (data) => { log += data })
    child.stderr.on("data", (data) => { log += data })
    const exit = await new Promise((resolve) => child.on("close", resolve))
    const result = await readFile(output, "utf8").catch(() => "")
    return { exit, result, log }
  } finally {
    server.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test("an application HTML response permits the deployed end-to-end check", async () => {
  const actual = await probe((request, response) => {
    assert.equal(request.url, "/r/aaaaaaaaaaaaaaaaaaaaaa")
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("app")
  })
  assert.equal(actual.exit, 0)
  assert.equal(actual.result, "result=app\n")
})

test("only the expected Access login for the probed host is protected, not app-ready", async () => {
  const actual = await probe((request, response) => {
    response.writeHead(302, { location: `https://phibkro.cloudflareaccess.com/cdn-cgi/access/login/127.0.0.1?token=not-logged` }).end()
  })
  assert.equal(actual.exit, 0)
  assert.equal(actual.result, "result=protected\n")
  assert.match(actual.log, /app readiness and deployed end-to-end behavior were not verified/)
  assert.doesNotMatch(actual.log, /not-logged/)
})

test("unexpected redirects fail without following them", async () => {
  for (const location of [
    "https://other.cloudflareaccess.com/cdn-cgi/access/login/127.0.0.1",
    "https://phibkro.cloudflareaccess.com/cdn-cgi/access/login/other.example",
    "https://phibkro.cloudflareaccess.com.evil.example/cdn-cgi/access/login/127.0.0.1",
    "/login",
  ]) {
    const actual = await probe((request, response) => response.writeHead(302, { location }).end())
    assert.notEqual(actual.exit, 0)
    assert.equal(actual.result, "")
    assert.match(actual.log, /Unexpected preview redirect/)
  }
})

test("a transient failure is retried, not accepted", async () => {
  let requests = 0
  const actual = await probe((request, response) => {
    requests++
    if (requests === 1) response.writeHead(503).end()
    else response.writeHead(200, { "content-type": "text/html" }).end("app")
  })
  assert.equal(requests, 2)
  assert.equal(actual.result, "result=app\n")
})
