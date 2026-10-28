/**
 * End-to-end check of the MVP: two isolated browsers run the built apps/web against the real room server.
 *
 * `bun run e2e` from apps/web builds nothing; run `bun run build` first. Without `BASE_URL` it starts `wrangler dev`
 * from platforms/cloudflare (Durable Object and all) serving apps/web/dist; with `BASE_URL=https://...` it drives a
 * deployed Worker instead. Scenarios:
 *
 * - basic: four files, one empty, arrive byte-identical (SHA-256 per file);
 * - resume: the recipient's socket and later the sender's are cut mid-transfer, and the files still arrive identical;
 * - half-open: the same, but the server never hears the close, as after a network change;
 * - throughput: 256 MB without socket routing, to report the relay's speed rather than Playwright's;
 * - decline: the sender sees the refusal;
 * - wrong key: a damaged link fails on the recipient, and a well-formed wrong key is refused by the room;
 * - invariant: no request URL and no socket frame either browser sends carries the link secret or a file name.
 *
 * Sockets are cut through Playwright's WebSocket routing (close code 1012, "service restart"), so the server needs no
 * test-only endpoint. Exits non-zero on the first failed check.
 */
import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page, type WebSocketRoute } from "playwright"

interface PayloadFile {
  readonly name: string
  readonly mimeType: string
  readonly buffer: Buffer
}

interface Observed {
  readonly urls: Array<string>
  readonly frames: Array<Buffer>
  readonly sockets: Array<{ readonly page: WebSocketRoute; readonly server: WebSocketRoute }>
}

const appDirectory = new URL("..", import.meta.url).pathname
const platformDirectory = new URL("../../../platforms/cloudflare/", import.meta.url).pathname
const configuredBase = process.env["BASE_URL"]
const timeoutMilliseconds = Number(process.env["E2E_TIMEOUT_MS"] ?? 180_000)

let passed = 0
const payloadDirectory = mkdtempSync(join(tmpdir(), "file-transfer-e2e-files-"))
const check = (condition: boolean, description: string, detail?: unknown) => {
  if (!condition) throw new Error(`FAILED: ${description}${detail === undefined ? "" : `\n  got: ${JSON.stringify(detail)}`}`)
  passed++
  console.log(`ok ${passed} ${description}`)
}

const sha256 = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex")
const payload = (sizes: ReadonlyArray<readonly [string, number]>): Array<PayloadFile> =>
  sizes.map(([name, size]) => ({ name, mimeType: "application/octet-stream", buffer: randomBytes(size) }))

const startLocalServer = async () => {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const scratch = mkdtempSync(join(tmpdir(), "file-transfer-e2e-"))
  const environment = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", WRANGLER_SEND_METRICS: "false" }
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: platformDirectory, env: environment, stdout: "ignore", stderr: "pipe" })
  if (build.exitCode !== 0) throw new Error(`platform build failed:\n${build.stderr.toString()}`)
  const wrangler = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(port + 1),
      "--assets",
      join(appDirectory, "dist"),
      "--persist-to",
      join(scratch, "state"),
      "--show-interactive-dev-session=false",
      "--log-level",
      "warn",
    ],
    { cwd: platformDirectory, env: environment, stdout: "ignore", stderr: "pipe" },
  )
  const origin = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${origin}/`)).ok) {
        return {
          origin,
          stop: async () => {
            wrangler.kill()
            await wrangler.exited
            rmSync(scratch, { recursive: true, force: true })
          },
        }
      }
    } catch {
      // not listening yet
    }
    await Bun.sleep(500)
  }
  wrangler.kill()
  throw new Error("wrangler dev did not start within 60 s")
}

/** A fresh browser profile whose page records every request URL and every socket frame it sends. */
const openPage = async (browser: Browser, routed = true) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const observed: Observed = { urls: [], frames: [], sockets: [] }
  const errors: Array<string> = []
  page.on("request", (request) => observed.urls.push(request.url()))
  page.on("pageerror", (error) => errors.push(error.message))
  if (routed)
    await page.routeWebSocket(/\/api\/rooms\/.+\/socket/, (socket) => {
      observed.urls.push(socket.url())
      const server = socket.connectToServer()
      observed.sockets.push({ page: socket, server })
      socket.onMessage((message) => {
        observed.frames.push(typeof message === "string" ? Buffer.from(message) : message)
        server.send(message)
      })
      server.onMessage((message) => socket.send(message))
      const closeOptions = (code: number | undefined, reason: string | undefined) => ({
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
      })
      socket.onClose((code, reason) => server.close(closeOptions(code, reason)))
      server.onClose((code, reason) => socket.close(closeOptions(code, reason)))
    })
  return { page, observed, errors, close: () => context.close() }
}

const status = (page: Page) => page.evaluate(() => window.fileTransferTest?.status())
const waitForStatus = (page: Page, wanted: ReadonlyArray<string>, timeout = timeoutMilliseconds) =>
  page.waitForFunction((statuses) => statuses.includes(window.fileTransferTest?.status() ?? ""), wanted, { timeout })
const waitForProgress = (page: Page, fraction: number) =>
  page.waitForFunction(
    (wanted) => {
      const progress = window.fileTransferTest?.progress()
      return progress !== undefined && progress.total > 0 && progress.done / progress.total >= wanted
    },
    fraction,
    { timeout: timeoutMilliseconds },
  )

/**
 * Cuts the page's current socket. "clean" closes both ends, as a server restart would; "half-open" closes only the
 * browser's end, as a network change does when the server never hears the close.
 */
const cutSocket = async (observed: Observed, mode: "clean" | "half-open") => {
  const socket = observed.sockets.at(-1)
  if (socket === undefined) throw new Error("no socket to cut")
  await socket.page.close({ code: 1012, reason: "e2e cut" })
  if (mode === "clean") await socket.server.close({ code: 1001, reason: "e2e cut" })
}

const describe = async (label: string, page: Page, observed: Observed) =>
  `${label}: status ${await status(page)}, progress ${JSON.stringify(await page.evaluate(() => window.fileTransferTest?.progress()))}, failure ${await page.evaluate(() => window.fileTransferTest?.failure())}, sockets ${observed.sockets.length}`

const offer = async (sender: Page, base: string, files: ReadonlyArray<PayloadFile>) => {
  await sender.goto(`${base}/`)
  // Playwright takes in-memory files only up to 50 MB in total, so larger payloads go through a temporary directory.
  const total = files.reduce((sum, file) => sum + file.buffer.length, 0)
  if (total < 40 * 1024 * 1024) await sender.setInputFiles("#files", [...files])
  else {
    // The browser reads files lazily, so they stay until the run ends; deleting them early is a source change.
    for (const file of files) writeFileSync(join(payloadDirectory, file.name), file.buffer)
    await sender.setInputFiles(
      "#files",
      files.map((file) => join(payloadDirectory, file.name)),
    )
  }
  await waitForStatus(sender, ["waiting-for-recipient", "failed"])
  check(
    (await status(sender)) === "waiting-for-recipient",
    "the sender creates a room and waits",
    await sender.evaluate(() => window.fileTransferTest?.failure()),
  )
  return sender.inputValue("#link")
}

/** The invariant from CLAUDE.md, as seen from the browsers: nothing they send carries the secret or a file name. */
const checkNothingLeaks = (link: string, files: ReadonlyArray<PayloadFile>, observedList: ReadonlyArray<Observed>) => {
  const secret = new URL(link).hash.slice(1)
  check(secret.length >= 32, "the link carries its secret in the fragment")
  const needles = [secret, ...files.map((file) => file.name)]
  const leaks: Array<string> = []
  for (const observed of observedList) {
    for (const url of observed.urls)
      for (const needle of needles) if (url.includes(needle)) leaks.push(`url contains ${needle === secret ? "the secret" : needle}`)
    for (const frame of observed.frames)
      for (const needle of needles) if (frame.includes(Buffer.from(needle))) leaks.push(`frame contains ${needle === secret ? "the secret" : needle}`)
  }
  check(leaks.length === 0, "no request URL or socket frame carries the secret or a file name", leaks.slice(0, 5))
}

const transfer = async (browser: Browser, base: string, scenario: "basic" | "resume" | "half-open" | "throughput") => {
  const files =
    scenario === "throughput"
      ? payload([["hotel-video.bin", 256 * 1024 * 1024]])
      : scenario === "basic"
        ? payload([
            ["alpha-report.bin", 1_500_000],
            ["empty-notes.dat", 0],
            ["bravo-letter.txt", 300_001],
            ["charlie-image.bin", 65_536],
          ])
        : payload([
            ["delta-archive.bin", 16 * 1024 * 1024 + 123],
            ["echo-readme.txt", 5_000],
          ])
  const total = files.reduce((sum, file) => sum + file.buffer.length, 0)
  // Playwright copies every routed frame through its own protocol, so throughput runs without routing.
  const routed = scenario !== "throughput"
  const sender = await openPage(browser, routed)
  const recipient = await openPage(browser, routed)
  try {
    const link = await offer(sender.page, base, files)
    await recipient.page.goto(link)
    await waitForStatus(recipient.page, ["reviewing", "failed"])
    check((await status(recipient.page)) === "reviewing", `${scenario}: the recipient reviews the contract before any content`)
    const listed = (await recipient.page.locator(".file-list li").allTextContents()).join("\n")
    check(
      files.every((file) => listed.includes(file.name)),
      `${scenario}: the recipient sees every file name`,
      listed,
    )
    await recipient.page.getByRole("button", { name: "Accept" }).click()
    const started = performance.now()
    try {
      if (scenario === "resume" || scenario === "half-open") {
        const mode = scenario === "resume" ? "clean" : "half-open"
        await waitForProgress(recipient.page, 0.3)
        await cutSocket(recipient.observed, mode)
        await waitForProgress(recipient.page, 0.6)
        await cutSocket(sender.observed, mode)
      }
      await waitForStatus(recipient.page, ["complete", "failed"])
      await waitForStatus(sender.page, ["complete", "failed"])
    } catch (error) {
      console.log(`   ${await describe("sender", sender.page, sender.observed)}\n   ${await describe("recipient", recipient.page, recipient.observed)}`)
      throw error
    }
    const seconds = (performance.now() - started) / 1000
    check((await status(recipient.page)) === "complete" && (await status(sender.page)) === "complete", `${scenario}: both sides complete`, {
      recipient: await recipient.page.evaluate(() => window.fileTransferTest?.failure()),
    })
    const hashes = await recipient.page.evaluate(() => window.fileTransferTest?.fileHashes())
    check(JSON.stringify(hashes) === JSON.stringify(files.map((file) => sha256(file.buffer))), `${scenario}: every file arrives byte-identical`, hashes)
    if (scenario === "resume" || scenario === "half-open") {
      check(recipient.observed.sockets.length >= 2 && sender.observed.sockets.length >= 2, `${scenario}: both sides reconnected after their socket was cut`, {
        recipient: recipient.observed.sockets.length,
        sender: sender.observed.sockets.length,
      })
    }
    console.log(`   ${scenario}: ${(total / 1e6).toFixed(1)} MB in ${seconds.toFixed(1)} s (${(total / 1e6 / seconds).toFixed(1)} MB/s)`)
    if (routed) checkNothingLeaks(link, files, [sender.observed, recipient.observed])
    check(sender.errors.length === 0 && recipient.errors.length === 0, `${scenario}: no uncaught page errors`, [...sender.errors, ...recipient.errors])
  } finally {
    await sender.close()
    await recipient.close()
  }
}

const decline = async (browser: Browser, base: string) => {
  const sender = await openPage(browser)
  const recipient = await openPage(browser)
  try {
    const link = await offer(sender.page, base, payload([["foxtrot-decline.bin", 10_000]]))
    await recipient.page.goto(link)
    await waitForStatus(recipient.page, ["reviewing"])
    await recipient.page.getByRole("button", { name: "Decline" }).click()
    await waitForStatus(sender.page, ["declined", "failed"])
    check((await status(sender.page)) === "declined", "decline: the sender sees the refusal")
  } finally {
    await sender.close()
    await recipient.close()
  }
}

const wrongKey = async (browser: Browser, base: string) => {
  const sender = await openPage(browser)
  const damaged = await openPage(browser)
  const wrong = await openPage(browser)
  try {
    const link = await offer(sender.page, base, payload([["golf-secret.bin", 10_000]]))
    await damaged.page.goto(link.replace(/#.*/, "#AAAA"))
    await waitForStatus(damaged.page, ["failed"])
    check((await damaged.page.evaluate(() => window.fileTransferTest?.failure())) === "invalid-secret", "wrong key: a damaged link fails on the recipient")
    await wrong.page.goto(link.replace(/#.*/, `#${Buffer.alloc(32, 7).toString("base64url")}`))
    await waitForStatus(wrong.page, ["failed"])
    const failure = await wrong.page.evaluate(() => window.fileTransferTest?.failure())
    check(failure === "wrong room token", "wrong key: the room refuses a well-formed wrong key", failure)
    check((await status(sender.page)) === "waiting-for-recipient", "wrong key: the sender keeps waiting for the real recipient")
  } finally {
    await sender.close()
    await damaged.close()
    await wrong.close()
  }
}

const local = configuredBase === undefined ? await startLocalServer() : undefined
const base = configuredBase ?? local?.origin ?? ""
console.log(`end to end against ${base}`)
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  const response = await page.goto(`${base}/r/some-room`)
  check(response?.ok() === true, "a recipient link path serves the app")
  await page.close()
  await transfer(browser, base, "basic")
  await transfer(browser, base, "resume")
  if (process.env["E2E_HALF_OPEN"] !== "0") await transfer(browser, base, "half-open")
  await transfer(browser, base, "throughput")
  await decline(browser, base)
  await wrongKey(browser, base)
  console.log(`\nall ${passed} checks passed`)
} finally {
  await browser.close()
  await local?.stop()
  rmSync(payloadDirectory, { recursive: true, force: true })
}
