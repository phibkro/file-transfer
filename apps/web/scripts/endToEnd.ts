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
 *
 * `E2E_BROWSER` picks chromium (default), firefox or webkit for both sides. `E2E_SUITE` picks what runs:
 *
 * - `standard` (default): the scenarios above;
 * - `latency`: 128 MB throughput through scripts/latencyProxy.ts at round trips of 0, 50, 150 and 300 ms (local only);
 * - `large`: one transfer of `E2E_LARGE_GB` gigabytes (default 10) from a sparse file with random markers every GiB,
 *   checked by size and by sampling the markers and the zeros between them, since a browser cannot hash 10 GB in
 *   memory; the parcel's labels already check every record's contents. Set `E2E_TIMEOUT_MS` to a few hours.
 */
import { createHash, randomBytes } from "node:crypto"
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import { chromium, firefox, webkit } from "playwright"
import type { Browser, BrowserContext, Page, WebSocketRoute } from "playwright"
import { startLatencyProxy } from "./latencyProxy.ts"

declare global {
  interface Window {
    /** Set by the init script below: the extensions each socket negotiated. */
    negotiatedSocketExtensions?: string[]
  }
}

interface PayloadFile {
  readonly name: string
  readonly mimeType: string
  readonly buffer: Buffer
}

interface Observed {
  readonly urls: string[]
  readonly frames: Buffer[]
  readonly sockets: { readonly page: WebSocketRoute; readonly server: WebSocketRoute }[]
}

const appDirectory = new URL("..", import.meta.url).pathname
const platformDirectory = new URL("../../../platforms/cloudflare/", import.meta.url).pathname
const configuredBase = process.env.BASE_URL
const browserName = process.env.E2E_BROWSER ?? "chromium"

const browserTypes = new Map([
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
])

const browserType = browserTypes.get(browserName) ?? chromium
const suite = process.env.E2E_SUITE ?? "standard"
const timeoutMilliseconds = Number(process.env.E2E_TIMEOUT_MS ?? 180_000)

let passed = 0
const payloadDirectory = mkdtempSync(nodePath.join(tmpdir(), "file-transfer-e2e-files-"))

/** What a failed check prints. */
type Detail = string | readonly string[] | Readonly<Record<string, string | number | undefined>>

const check = (condition: boolean, description: string, detail?: Detail) => {
  if (!condition) {
    throw new Error(`FAILED: ${description}${detail === undefined ? "" : `\n  got: ${JSON.stringify(detail)}`}`)
  }

  passed++
  console.log(`ok ${passed} ${description}`)
}

const sha256 = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex")

const payload = (sizes: readonly (readonly [string, number])[]): PayloadFile[] =>
  sizes.map(([name, size]) => ({ name, mimeType: "application/octet-stream", buffer: randomBytes(size) }))

const startLocalServer = async () => {
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const scratch = mkdtempSync(nodePath.join(tmpdir(), "file-transfer-e2e-"))
  const environment = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", WRANGLER_SEND_METRICS: "false" }
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: platformDirectory, env: environment, stdout: "ignore", stderr: "pipe" })

  if (build.exitCode !== 0) {
    throw new Error(`platform build failed:\n${build.stderr.toString()}`)
  }

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
      nodePath.join(appDirectory, "dist"),
      "--persist-to",
      nodePath.join(scratch, "state"),
      "--show-interactive-dev-session=false",
      "--log-level",
      "warn",
    ],
    { cwd: platformDirectory, env: environment, stdout: "ignore", stderr: "pipe" },
  )

  const origin = `http://127.0.0.1:${port}`

  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${origin}/`)

      if (response.ok) {
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
interface CloseOptions {
  code?: number
  reason?: string
}

/** Close options with only the fields a close actually carried. */
const closeOptions = (code: number | undefined, reason: string | undefined) => {
  const options: CloseOptions = {}

  if (code !== undefined) {
    options.code = code
  }

  if (reason !== undefined) {
    options.reason = reason
  }

  return options
}

/**
 * A fresh, isolated profile per page. WebKit offers the origin-private file system only in a persistent profile (its
 * ephemeral contexts count as private browsing), so under WebKit, and wherever a normal quota is needed, a page gets
 * a temporary profile directory.
 */
const newContext = async (browser: Browser, persistent: boolean): Promise<{ readonly context: BrowserContext; readonly dispose: () => void }> => {
  if (browserName !== "webkit" && !persistent) {
    return { context: await browser.newContext(), dispose: () => undefined }
  }

  const directory = mkdtempSync(nodePath.join(tmpdir(), "file-transfer-e2e-webkit-"))

  return {
    context: await browserType.launchPersistentContext(directory),
    dispose: () => {
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

/**
 * A page in its own profile. `persistent` gives it a normal on-disk profile; ephemeral contexts count as private
 * windows, whose storage quota (about 2.1 GB in headless Chromium) is too small for the large suite.
 */
const openPage = async (browser: Browser, routed = true, persistent = false) => {
  const { context, dispose } = await newContext(browser, persistent)
  // Records the extensions each socket negotiated, to report whether the relay path compresses.
  await context.addInitScript(() => {
    const negotiated: string[] = []
    const Native = window.WebSocket
    window.negotiatedSocketExtensions = negotiated
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        this.addEventListener("open", () => {
          negotiated.push(this.extensions)
        })
      }
    }
  })
  const page = await context.newPage()
  const observed: Observed = { urls: [], frames: [], sockets: [] }
  const errors: string[] = []
  page.on("request", (request) => observed.urls.push(request.url()))
  page.on("pageerror", (error) => errors.push(error.message))

  if (routed) {
    await page.routeWebSocket(/\/api\/rooms\/.+\/socket/u, (socket) => {
      observed.urls.push(socket.url())
      const server = socket.connectToServer()
      observed.sockets.push({ page: socket, server })
      socket.onMessage((message) => {
        observed.frames.push(Buffer.isBuffer(message) ? message : Buffer.from(message))
        server.send(message)
      })
      server.onMessage((message) => {
        socket.send(message)
      })

      socket.onClose(async (code, reason) => {
        await server.close(closeOptions(code, reason))
      })
      server.onClose(async (code, reason) => {
        await socket.close(closeOptions(code, reason))
      })
    })
  }

  const close = async () => {
    await context.close()
    dispose()
  }

  return { page, observed, errors, close }
}

const status = async (page: Page) => await page.evaluate(() => window.fileTransferTest?.status())

const waitForStatus = async (page: Page, wanted: readonly string[], timeout = timeoutMilliseconds) =>
  await page.waitForFunction((statuses) => statuses.includes(window.fileTransferTest?.status() ?? ""), wanted, { timeout })

const waitForProgress = async (page: Page, fraction: number) =>
  await page.waitForFunction(
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

  if (socket === undefined) {
    throw new Error("no socket to cut")
  }

  await socket.page.close({ code: 1012, reason: "e2e cut" })

  if (mode === "clean") {
    await socket.server.close({ code: 1001, reason: "e2e cut" })
  }
}

const describe = async (label: string, page: Page, observed: Observed) =>
  `${label}: status ${await status(page)}, progress ${JSON.stringify(await page.evaluate(() => window.fileTransferTest?.progress()))}, failure ${await page.evaluate(() => window.fileTransferTest?.failure())}, sockets ${observed.sockets.length}`

const offer = async (sender: Page, base: string, files: readonly PayloadFile[]) => {
  await sender.goto(`${base}/`)
  // Playwright takes in-memory files only up to 50 MB in total, so larger payloads go through a temporary directory.
  const total = files.reduce((sum, file) => sum + file.buffer.length, 0)

  if (total < 40 * 1024 * 1024) {
    // Two batches, so the check covers adding files after the first choice; all of them become one parcel.
    const split = Math.ceil(files.length / 2)
    await sender.setInputFiles("#files", files.slice(0, split))

    if (split < files.length) {
      await sender.setInputFiles("#files", files.slice(split))
    }

    const listed = await sender.locator(".file-list li").count()
    check(listed === files.length, "files chosen in two batches are all in the list", { listed, expected: files.length })
  } else {
    // The browser reads files lazily, so they stay until the run ends; deleting them early is a source change.
    for (const file of files) {
      writeFileSync(nodePath.join(payloadDirectory, file.name), file.buffer)
    }

    await sender.setInputFiles(
      "#files",
      files.map((file) => nodePath.join(payloadDirectory, file.name)),
    )
  }

  await sender.getByRole("button", { name: "Create link" }).click()
  await waitForStatus(sender, ["waiting-for-recipient", "failed"])
  check(
    (await status(sender)) === "waiting-for-recipient",
    "the sender creates a room and waits",
    await sender.evaluate(() => window.fileTransferTest?.failure()),
  )

  // The link and its QR code stay hidden until asked for (apps/web/src/share.ts).
  const masked = await sender.inputValue("#link")
  check(
    masked.endsWith("•".repeat(12)) && !masked.includes("#A") && (await sender.locator("#share-qr svg").count()) === 0,
    "the link and QR code are hidden by default",
    masked,
  )
  await sender.getByRole("button", { name: "Show link" }).click()
  const link = await sender.inputValue("#link")
  check(new URL(link).hash.length > 32, "Show link reveals the full link")
  await sender.getByRole("button", { name: "Show QR code" }).click()
  check(await sender.locator("#share-qr svg").isVisible(), "Show QR code draws the QR code")
  await sender.getByRole("button", { name: "Hide QR code" }).click()
  check(await sender.locator("#share-qr").isHidden(), "Hide QR code hides it again")

  return link
}

/** The invariant from CLAUDE.md, as seen from the browsers: nothing they send carries the secret or a file name. */
const checkNothingLeaks = (link: string, files: readonly PayloadFile[], observedList: readonly Observed[]) => {
  const secret = new URL(link).hash.slice(1)
  check(secret.length >= 32, "the link carries its secret in the fragment")
  const needles = [secret, ...files.map((file) => file.name)]
  const leaks: string[] = []

  for (const observed of observedList) {
    for (const url of observed.urls) {
      for (const needle of needles) {
        if (url.includes(needle)) {
          leaks.push(`url contains ${needle === secret ? "the secret" : needle}`)
        }
      }
    }

    for (const frame of observed.frames) {
      for (const needle of needles) {
        if (frame.includes(Buffer.from(needle))) {
          leaks.push(`frame contains ${needle === secret ? "the secret" : needle}`)
        }
      }
    }
  }

  check(leaks.length === 0, "no request URL or socket frame carries the secret or a file name", leaks.slice(0, 5))
}

type TransferScenario = "basic" | "resume" | "half-open" | "throughput" | "latency"

/** File names and sizes per scenario. */
type PayloadPlan = { readonly [Scenario in TransferScenario]: readonly (readonly [string, number])[] }

const payloadSizes: PayloadPlan = {
  basic: [
    ["alpha-report.bin", 1_500_000],
    ["empty-notes.dat", 0],
    ["bravo-letter.txt", 300_001],
    ["charlie-image.bin", 65_536],
  ],
  resume: [
    ["delta-archive.bin", 16 * 1024 * 1024 + 123],
    ["echo-readme.txt", 5000],
  ],
  "half-open": [
    ["delta-archive.bin", 16 * 1024 * 1024 + 123],
    ["echo-readme.txt", 5000],
  ],
  throughput: [["hotel-video.bin", 256 * 1024 * 1024]],
  latency: [["india-recording.bin", 128 * 1024 * 1024]],
}

/**
 * How received files differ from what was sent: size, and the offset of the first differing byte with a few bytes on
 * each side. For diagnosing a browser whose storage returns other bytes than were written (WebKit, 2026-10-28).
 */
const describeDifferences = async (page: Page, files: readonly PayloadFile[]): Promise<string> => {
  const sizes = await page.evaluate(() => window.fileTransferTest?.fileSizes() ?? [])
  const reports: string[] = []

  for (const [index, file] of files.entries()) {
    const size = sizes[index] ?? -1
    const length = Math.min(size, file.buffer.length, 4 * 1024 * 1024)

    const received = Buffer.from(
      await page.evaluate(async ([fileIndex, end]) => (await window.fileTransferTest?.fileSlice(fileIndex, 0, end)) ?? "", [index, length] as const),
      "hex",
    )

    let first = -1

    for (let offset = 0; offset < length; offset++) {
      if (received[offset] !== file.buffer[offset]) {
        first = offset
        break
      }
    }

    const around = (buffer: Buffer) => buffer.subarray(Math.max(0, first - 4), first + 12).toString("hex")
    reports.push(
      `file ${index}: sent ${file.buffer.length} bytes, received ${size}${first === -1 ? `, first ${length} bytes equal` : `, first difference at ${first} (sent ${around(file.buffer)}, received ${around(received)})`}`,
    )
  }

  return reports.join("; ")
}

/** Megabytes per second of the last completed transfer, for the latency suite's table. */
let lastMegabytesPerSecond = 0

const transfer = async (browser: Browser, base: string, scenario: TransferScenario) => {
  const files = payload(payloadSizes[scenario])

  const total = files.reduce((sum, file) => sum + file.buffer.length, 0)
  // Playwright copies every routed frame through its own protocol, so throughput runs without routing.
  const routed = scenario !== "throughput" && scenario !== "latency"
  const sender = await openPage(browser, routed)
  const recipient = await openPage(browser, routed)

  try {
    const link = await offer(sender.page, base, files)
    await recipient.page.goto(link)
    await waitForStatus(recipient.page, ["reviewing", "failed"])
    check((await status(recipient.page)) === "reviewing", `${scenario}: the recipient reviews the contract before any content`)
    const listedItems = await recipient.page.locator(".file-list li").allTextContents()
    const listed = listedItems.join("\n")
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
    const hashes = await recipient.page.evaluate(async () => await window.fileTransferTest?.fileHashes())
    const identical = JSON.stringify(hashes) === JSON.stringify(files.map((file) => sha256(file.buffer)))

    if (!identical) {
      console.log(`   ${scenario}: ${await describeDifferences(recipient.page, files)}`)
    }

    check(identical, `${scenario}: every file arrives byte-identical`, hashes)

    if (files.length > 1) {
      check(await recipient.page.getByRole("button", { name: /^Save all files/u }).isVisible(), `${scenario}: several files offer Save all files`)
    }

    const summaries = [
      await sender.page.locator(".summary").textContent({ timeout: 10_000 }),
      await recipient.page.locator(".summary").textContent({ timeout: 10_000 }),
    ]

    check(
      summaries.every((text) => text !== null && text.includes("Speed") && !files.some((file) => file.name.length > 0 && text.includes(file.name))),
      `${scenario}: both sides show a completion summary without file names`,
      summaries.map((text) => text ?? ""),
    )

    if (scenario === "resume" || scenario === "half-open") {
      check(recipient.observed.sockets.length >= 2 && sender.observed.sockets.length >= 2, `${scenario}: both sides reconnected after their socket was cut`, {
        recipient: recipient.observed.sockets.length,
        sender: sender.observed.sockets.length,
      })
    }

    lastMegabytesPerSecond = total / 1e6 / seconds
    console.log(`   ${scenario}: ${(total / 1e6).toFixed(1)} MB in ${seconds.toFixed(1)} s (${lastMegabytesPerSecond.toFixed(1)} MB/s)`)

    if (routed) {
      checkNothingLeaks(link, files, [sender.observed, recipient.observed])
    } else {
      // Unrouted sockets negotiate with the real server, so this is the relay's own answer to the browser's offer.
      const extensions = [
        ...(await sender.page.evaluate(() => window.negotiatedSocketExtensions ?? [])),
        ...(await recipient.page.evaluate(() => window.negotiatedSocketExtensions ?? [])),
      ]

      // Reported, not checked: the layer in front of the Worker (Cloudflare's edge, Miniflare locally) answers the
      // browser's permessage-deflate offer before the Worker runs, so neither the Worker nor the page can refuse it.
      console.log(`   ${scenario}: negotiated socket extensions ${JSON.stringify([...new Set(extensions)])}`)
    }

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
    await damaged.page.goto(link.replace(/#.*/u, "#AAAA"))
    await waitForStatus(damaged.page, ["failed"])
    check((await damaged.page.evaluate(() => window.fileTransferTest?.failure())) === "invalid-secret", "wrong key: a damaged link fails on the recipient")
    await wrong.page.goto(link.replace(/#.*/u, `#${Buffer.alloc(32, 7).toString("base64url")}`))
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

const gibibyte = 1024 ** 3

/**
 * A sparse file of `gigabytes` GB holding random 64-byte markers at every GiB and at its end, so offsets can be checked
 * by sampling. Sparse, so it costs almost no disk; only the recipient's copy is written out in full.
 */
const sparsePayload = (gigabytes: number) => {
  const size = Math.round(gigabytes * 1e9)
  const path = nodePath.join(payloadDirectory, "kilo-disk-image.bin")
  const descriptor = openSync(path, "w")
  const markers: { readonly offset: number; readonly hex: string }[] = []

  try {
    ftruncateSync(descriptor, size)

    for (const offset of [...Array.from({ length: Math.floor((size - 64) / gibibyte) + 1 }, (_, index) => index * gibibyte), size - 64]) {
      const marker = randomBytes(64)
      writeSync(descriptor, marker, 0, marker.length, offset)
      markers.push({ offset, hex: marker.toString("hex") })
    }
  } finally {
    closeSync(descriptor)
  }

  return { path, size, markers }
}

const large = async (browser: Browser, base: string) => {
  const gigabytes = Number(process.env.E2E_LARGE_GB ?? 10)
  const file = sparsePayload(gigabytes)
  const sender = await openPage(browser, false, true)
  const recipient = await openPage(browser, false, true)
  const privateWindow = await openPage(browser, false)

  try {
    await sender.page.goto(`${base}/`)
    await sender.page.setInputFiles("#files", file.path)
    await sender.page.getByRole("button", { name: "Create link" }).click()
    await waitForStatus(sender.page, ["waiting-for-recipient", "failed"])
    check((await status(sender.page)) === "waiting-for-recipient", `large: the sender labels ${gigabytes} GB and waits`)
    await sender.page.getByRole("button", { name: "Show link" }).click()
    const link = await sender.page.inputValue("#link")

    // A private window's quota is smaller than the offer: the recipient must say so before accepting, not fail midway.
    if (browserName === "chromium" && file.size > 2.2e9) {
      await privateWindow.page.goto(link)
      await waitForStatus(privateWindow.page, ["reviewing", "failed"])
      await privateWindow.page.locator(".space-warning").waitFor({ timeout: 10_000 })
      check(
        await privateWindow.page.getByRole("button", { name: "Accept" }).isDisabled(),
        "large: a private window that cannot hold the files is warned and cannot accept",
      )
    }

    await privateWindow.close()
    await recipient.page.goto(link)
    await waitForStatus(recipient.page, ["reviewing", "failed"])
    await recipient.page.getByRole("button", { name: "Accept" }).click()
    const started = performance.now()
    await waitForStatus(recipient.page, ["complete", "failed"])
    await waitForStatus(sender.page, ["complete", "failed"])
    const seconds = (performance.now() - started) / 1000
    check(
      (await status(recipient.page)) === "complete",
      "large: the recipient completes",
      `${await recipient.page.evaluate(() => window.fileTransferTest?.failure())}: ${await recipient.page.evaluate(() => window.fileTransferTest?.failureDetail())}`,
    )
    const sizes = await recipient.page.evaluate(() => window.fileTransferTest?.fileSizes() ?? [])
    check(sizes.length === 1 && sizes[0] === file.size, "large: the received file has the sent size", sizes.map(String))
    const zeros = "00".repeat(64)

    const samples = await recipient.page.evaluate(
      async (offsets) => await Promise.all(offsets.map(async (offset) => (await window.fileTransferTest?.fileSlice(0, offset, offset + 64)) ?? "")),
      file.markers.flatMap((marker) => [marker.offset, Math.min(marker.offset + 1024 * 1024, file.size - 128)]),
    )

    const expected = file.markers.flatMap((marker) => [marker.hex, zeros])
    check(JSON.stringify(samples) === JSON.stringify(expected), `large: ${file.markers.length} markers and the zeros after them are at their offsets`)
    console.log(`   large: ${(file.size / 1e9).toFixed(1)} GB in ${seconds.toFixed(0)} s (${(file.size / 1e6 / seconds).toFixed(1)} MB/s)`)
  } finally {
    await sender.close()
    await recipient.close()
  }
}

/** Throughput at several round-trip times, through a delaying proxy in front of the local server. */
const latency = async (browser: Browser, origin: string) => {
  const target = new URL(origin)
  const rows: string[] = []

  for (const roundTrip of [0, 50, 150, 300]) {
    const proxy = startLatencyProxy({ hostname: target.hostname, port: Number(target.port) }, roundTrip / 2)

    try {
      console.log(`   round trip ${roundTrip} ms`)
      await transfer(browser, proxy.origin, "latency")
      rows.push(`${roundTrip} ms: ${lastMegabytesPerSecond.toFixed(1)} MB/s`)
    } finally {
      proxy.stop()
    }
  }

  console.log(`   latency results (128 MB, credit window from apps/web/src/recipient.ts): ${rows.join(", ")}`)
}

const local = configuredBase === undefined ? await startLocalServer() : undefined
const base = configuredBase ?? local?.origin ?? ""

console.log(`end to end against ${base} in ${browserName}, suite ${suite}`)

const browser = await browserType.launch()

try {
  if (suite === "large") {
    await large(browser, base)
  } else if (suite === "latency") {
    check(local !== undefined, "the latency suite runs against the local server only")
    await latency(browser, base)
  } else {
    const page = await browser.newPage()
    const response = await page.goto(`${base}/r/some-room`)
    check(response?.ok() === true, "a recipient link path serves the app", `status ${response?.status() ?? "none"}`)
    await page.close()
    await transfer(browser, base, "basic")
    await transfer(browser, base, "resume")

    if (process.env.E2E_HALF_OPEN !== "0") {
      await transfer(browser, base, "half-open")
    }

    await transfer(browser, base, "throughput")
    await decline(browser, base)
    await wrongKey(browser, base)
  }

  console.log(`\nall ${passed} checks passed`)
} finally {
  await browser.close()
  await local?.stop()
  rmSync(payloadDirectory, { recursive: true, force: true })
}
