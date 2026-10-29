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
 *   memory; the parcel's labels already check every record's contents. Set `E2E_TIMEOUT_MS` to a few hours;
 * - `chaos`: a join the room never answers, then transfers under seeded faults (faultPlan.ts): sockets cut cleanly or
 *   half-open, stalled, blackholed or slowed, records replayed by the relay, direct paths killed; `E2E_SEED` and
 *   `E2E_RUNS` choose the plans;
 * - `lab`: transfers between two homes behind emulated routers in Linux network namespaces (networkLab.ts): open,
 *   symmetric and UDP-blocking NATs, slow and lossy links, a router that drops everything or moves address; needs root,
 *   coturn's `turnserver`, and chromium or firefox; `E2E_LAB_ONLY` picks scenarios by name;
 * - `scenario`: one transfer scenario (`E2E_SCENARIO`, default half-open) `E2E_REPEAT` times (default 10), to chase a
 *   failure that shows up in a few runs out of many.
 */
import { createHash, randomBytes } from "node:crypto"
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import { chromium, firefox, webkit } from "playwright"
import type { Browser, BrowserContext, LaunchOptions, Page, WebSocketRoute } from "playwright"
import { describePlan, faultPlan } from "./faultPlan.ts"
import { blackhole, browserInHome, build as buildLab, hasNetem, impair, moveRouter, serverAddress, setNat, tearDown as tearDownLab } from "./networkLab.ts"
import type { Impairment, LabSide, NatBehaviour } from "./networkLab.ts"
import type { Fault, FaultPlan, Side } from "./faultPlan.ts"
import { startLatencyProxy } from "./latencyProxy.ts"

declare global {
  interface Window {
    /** Set by the init script below: the extensions each socket negotiated. */
    negotiatedSocketExtensions?: string[]
    /** Set by the chaos init script: kills every data channel and peer connection on the page. */
    chaosDropDirect?: () => number
    /** Set by the chaos init script: each peer connection's state changes, with milliseconds since the page loaded. */
    peerStates?: string[]
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
  readonly sockets: RoutedSocket[]
  /** How many of the page's next sockets start blackholed, so their join is never answered. */
  silentSockets: number
}

/** What the chaos suite does to one routed socket (faultPlan.ts); untouched, frames pass straight through. */
interface SocketFaults {
  /** Frames wait until this time (milliseconds since the epoch) before passing. */
  pausedUntil: number
  /** Frames wait this long before passing, in order. */
  latency: number
  /** Nothing passes again, and the socket stays open. */
  blackholed: boolean
  /** When the last frame in each direction is due, so frames never overtake one another. */
  readonly due: { toServer: number; toPage: number }
}

interface RoutedSocket {
  readonly page: WebSocketRoute
  readonly server: WebSocketRoute
  readonly faults: SocketFaults
  /** The latest binary frames the server sent this page, for replaying them. */
  readonly fromServer: Buffer[]
}

/** Passes a frame on now, or later when a stall or latency holds it, or never once the socket is blackholed. */
const forward = (faults: SocketFaults, direction: "toServer" | "toPage", deliver: () => void) => {
  if (faults.blackholed) {
    return
  }

  const now = Date.now()
  const due = Math.max(now + faults.latency, faults.pausedUntil, faults.due[direction])
  faults.due[direction] = due

  const send = () => {
    if (!faults.blackholed) {
      try {
        deliver()
      } catch {
        // The other end closed meanwhile; a real network drops the frame too.
      }
    }
  }

  if (due <= now) {
    send()
  } else {
    setTimeout(send, due - now)
  }
}

const appDirectory = new URL("..", import.meta.url).pathname
const platformDirectory = new URL("../../../platforms/cloudflare/", import.meta.url).pathname
const selfHostedDirectory = new URL("../../../platforms/self-hosted/", import.meta.url).pathname
const configuredBase = process.env.BASE_URL
const browserName = process.env.E2E_BROWSER ?? "chromium"

const browserTypes = new Map([
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
])

const browserType = browserTypes.get(browserName) ?? chromium

/**
 * Two pages in one browser on one machine connect directly through their host candidates, which browsers hide behind
 * mDNS names by default; multicast DNS is often unavailable on CI machines, so the tests turn the hiding off.
 */
const launchOptionsByBrowser = new Map<string, LaunchOptions>([
  ["chromium", { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] }],
  ["firefox", { firefoxUserPrefs: { "media.peerconnection.ice.obfuscate_host_addresses": false } }],
])

const launchOptions: LaunchOptions = launchOptionsByBrowser.get(browserName) ?? {}

/**
 * WebKit sends data channel messages from a queue and, when a send fails there (the channel's transport went away under
 * it, as when the other side replaces the direct path after a reconnect), logs "Error sending binary data through
 * RTCDataChannel." to the console instead of throwing (WebCore RTCDataChannel::createMessageQueue). Playwright's WebKit
 * driver reports every JavaScript console error as a page error (wkPage.ts, _onConsoleMessage), so this message would
 * read as an uncaught exception. It is not one, and the app cannot catch it: the records it lost are requested again,
 * and the transfer's byte-identical check covers that. Any other page error still fails the check.
 */
const webKitSendFailures = new Set(["Error sending binary data through RTCDataChannel.", "Error sending string through RTCDataChannel."])

const isWebKitSendFailure = (message: string): boolean => browserName === "webkit" && webKitSendFailures.has(message)

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

  // The app too, so a local run never serves a stale apps/web/dist.
  for (const [label, directory] of [
    ["app", appDirectory],
    ["platform", platformDirectory],
  ] as const) {
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: directory, env: environment, stdout: "ignore", stderr: "pipe" })

    if (build.exitCode !== 0) {
      throw new Error(`${label} build failed:\n${build.stderr.toString()}`)
    }
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
      // Counting on with a known admin token, so the operator page can be checked (src/admin.ts).
      "--var",
      "COUNTERS:on",
      "--var",
      `ADMIN_TOKEN:${localAdminToken}`,
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
    context: await browserType.launchPersistentContext(directory, launchOptions),
    dispose: () => {
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

/**
 * A page in its own profile. `persistent` gives it a normal on-disk profile; ephemeral contexts count as private
 * windows, whose storage quota (about 2.1 GB in headless Chromium) is too small for the large suite.
 */
const openPage = async (browser: Browser, routed = true, persistent = false, direct = true, chaos = false) => {
  const { context, dispose } = await newContext(browser, persistent)

  if (chaos) {
    // Keeps every peer connection and data channel the page makes, so a fault can kill its direct path.
    await context.addInitScript(() => {
      const connections: RTCPeerConnection[] = []
      const channels: RTCDataChannel[] = []
      window.peerStates = []
      const Native = window.RTCPeerConnection
      window.RTCPeerConnection = class extends Native {
        constructor(configuration?: RTCConfiguration) {
          super(configuration)
          connections.push(this)
          const index = connections.length

          const log = (what: string) => {
            window.peerStates?.push(`${Math.round(performance.now())} ms: connection ${index} ${what}`)
          }

          log("created")

          this.addEventListener("signalingstatechange", () => {
            log(`signaling ${this.signalingState}`)
          })
          this.addEventListener("iceconnectionstatechange", () => {
            log(`ice ${this.iceConnectionState}`)
          })
          this.addEventListener("icegatheringstatechange", () => {
            log(`gathering ${this.iceGatheringState}`)
          })
          this.addEventListener("icecandidate", (event) => {
            log(`candidate ${event.candidate?.candidate.split(" ").slice(4, 8).join(" ") ?? "end"}`)
          })
          this.addEventListener("datachannel", (event) => {
            channels.push(event.channel)
          })
        }

        override createDataChannel(label: string, init?: RTCDataChannelInit) {
          const channel = super.createDataChannel(label, init)
          channels.push(channel)

          return channel
        }
      }
      window.chaosDropDirect = () => {
        for (const channel of channels) {
          channel.close()
        }

        for (const connection of connections) {
          connection.close()
        }

        return channels.length
      }
    })
  }

  if (!direct) {
    // The setting a person turns off under "Direct connections" (apps/web/src/directSettings.ts).
    await context.addInitScript(() => {
      localStorage.setItem("file-transfer:direct-connections", "off")
    })
  }

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
  const observed: Observed = { urls: [], frames: [], sockets: [], silentSockets: 0 }
  const errors: string[] = []
  page.on("request", (request) => observed.urls.push(request.url()))
  page.on("pageerror", (error) => {
    if (!isWebKitSendFailure(error.message)) {
      errors.push(error.message)
    }
  })

  if (routed) {
    await page.routeWebSocket(/\/api\/rooms\/.+\/socket/u, (socket) => {
      observed.urls.push(socket.url())
      const server = socket.connectToServer()
      const faults: SocketFaults = { pausedUntil: 0, latency: 0, blackholed: observed.silentSockets > 0, due: { toServer: 0, toPage: 0 } }
      observed.silentSockets = Math.max(0, observed.silentSockets - 1)
      const fromServer: Buffer[] = []
      observed.sockets.push({ page: socket, server, faults, fromServer })
      socket.onMessage((message) => {
        observed.frames.push(Buffer.isBuffer(message) ? message : Buffer.from(message))
        forward(faults, "toServer", () => {
          server.send(message)
        })
      })
      server.onMessage((message) => {
        if (Buffer.isBuffer(message)) {
          fromServer.push(message)
          fromServer.splice(0, Math.max(0, fromServer.length - 64))
        }

        forward(faults, "toPage", () => {
          socket.send(message)
        })
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

  await sender.getByRole("button", { name: "Seal parcel and create link" }).click()
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

  // The encoder loads on first use (src/share.ts), so the code appears a moment after the click.
  const qrDrawn = await sender
    .locator("#share-qr svg")
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false)

  check(qrDrawn, "Show QR code draws the QR code")
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

const transferScenarios = ["basic", "resume", "half-open", "throughput", "latency"] as const

type TransferScenario = (typeof transferScenarios)[number]

const isTransferScenario = (value: string): value is TransferScenario => transferScenarios.some((name) => name === value)

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

/** The transfers stored in a page's origin-private `transfers` directory. */
const storedTransfers = async (page: Page): Promise<readonly string[]> =>
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const transfers = await root.getDirectoryHandle("transfers", { create: true })
    const names: string[] = []

    for await (const name of transfers.keys()) {
      names.push(name)
    }

    return names
  })

/**
 * The storage panel shows what received files take and clears them; a transfer left behind by a closed tab is deleted
 * on the next page load.
 */
const checkStorageClearing = async (page: Page, base: string) => {
  const heading = page.locator(".storage-panel summary")
  const headingText = (await heading.textContent()) ?? ""
  check(/Storage in this browser: \d/u.test(headingText), "storage: the panel shows the size of received files", headingText)
  await heading.click()
  await page.getByRole("button", { name: "Clear stored files" }).click()
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await page.locator(".storage-text", { hasText: "No received files are stored here." }).waitFor({ timeout: 10_000 })
  const afterClear = await storedTransfers(page)
  check(afterClear.length === 0, "storage: Clear deletes this page's received files", afterClear)
  check((await page.locator(".downloads a[href]").count()) === 0, "storage: after Clear the page no longer offers the deleted files")

  // As a crashed tab leaves an unfinished transfer behind: no lock holds it, so the next load deletes it.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const transfers = await root.getDirectoryHandle("transfers", { create: true })
    const left = await transfers.getDirectoryHandle("abandoned", { create: true })
    const handle = await left.getFileHandle("0", { create: true })
    const writable = await handle.createWritable()
    await writable.write(new Uint8Array(1000))
    await writable.close()
  })
  await page.goto(base)
  await page.locator(".storage-panel").waitFor()
  const afterVisit = await storedTransfers(page)
  check(afterVisit.length === 0, "storage: a transfer left by a closed tab is deleted on the next visit", afterVisit)
}

/** A 64 by 48 orange PNG. */
const orangePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwAQMAAACbhe5cAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf+lAP////naJPcAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gocFyURsF4nIgAAAA5JREFUGNNjYBgFQwkAAAGwAAGHcNqeAAAAAElFTkSuQmCC",
  "base64",
)

/** The preview dialog's frame, and what it shows once it has rendered. */
const previewFrame = (page: Page) => page.frameLocator("iframe.preview-frame")

const closePreview = async (page: Page) => {
  await page.locator(".preview-dialog").getByRole("button", { name: "Close" }).click()
}

/**
 * Renaming and previews (docs/decisions/0018-previews-and-renaming.md): the sender renames a file before sealing and
 * the recipient sees the new name; the recipient renames a file it saves; both preview an image in a frame whose
 * origin is opaque; an HTML file previews as text, never as a page; and the preview page is sandboxed even when opened
 * on its own.
 */
const previewsAndNames = async (browser: Browser, base: string) => {
  const sender = await openPage(browser, false)
  const recipient = await openPage(browser, false)

  try {
    const files: PayloadFile[] = [
      { name: "photo.png", mimeType: "image/png", buffer: orangePng },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Packing list: tent, stove, map\n") },
      {
        name: "page.html",
        mimeType: "text/html",
        buffer: Buffer.from("<!doctype html><p id=hostile>hostile</p><script>parent.postMessage('ran', '*')</script>"),
      },
    ]

    await sender.page.goto(`${base}/`)
    await sender.page.setInputFiles("#files", files)

    await sender.page.getByRole("button", { name: "Preview photo.png" }).click()
    await previewFrame(sender.page).locator("img").waitFor({ timeout: 10_000 })

    const imageWidth = await previewFrame(sender.page)
      .locator("img")
      .evaluate((image: HTMLImageElement) => image.naturalWidth)

    const frameOrigin = await previewFrame(sender.page)
      .locator("body")
      .evaluate(() => window.origin)

    check(imageWidth === 64, "preview: the sender previews an image before sealing", String(imageWidth))
    check(frameOrigin === "null", "preview: previews render in a frame with an opaque origin", frameOrigin)
    await closePreview(sender.page)

    await sender.page.getByRole("button", { name: "Preview page.html" }).click()
    await previewFrame(sender.page).locator("pre").waitFor({ timeout: 10_000 })
    const shownAsText = (await previewFrame(sender.page).locator("pre").textContent()) ?? ""
    const hostileElements = await previewFrame(sender.page).locator("#hostile").count()
    check(shownAsText.includes("<script>") && hostileElements === 0, "preview: an HTML file previews as text, never as a page", shownAsText)
    await closePreview(sender.page)

    await sender.page.getByRole("button", { name: "Rename notes.txt" }).click()
    await sender.page.getByRole("textbox", { name: "New name for notes.txt" }).fill("con.txt")
    await sender.page.getByRole("button", { name: "Save" }).click()
    const refusal = (await sender.page.locator(".rename-problem").textContent()) ?? ""
    check(refusal.startsWith("This name cannot be used"), "rename: a name the parcel's rules forbid is refused in place", refusal)
    await sender.page.getByRole("textbox", { name: "New name for notes.txt" }).fill("packing list.txt")
    await sender.page.getByRole("button", { name: "Save" }).click()
    check((await sender.page.getByRole("button", { name: "Rename packing list.txt" }).count()) === 1, "rename: the sender renames a file before sealing")

    await sender.page.getByRole("button", { name: "Seal parcel and create link" }).click()
    await waitForStatus(sender.page, ["waiting-for-recipient", "failed"])
    check(
      (await sender.page.locator(".file-list button.rename, .file-list button.remove").count()) === 0 &&
        (await sender.page.getByRole("button", { name: "Send other files" }).isVisible()),
      "seal: a sealed parcel cannot be renamed or changed, and offers Send other files instead",
    )
    await sender.page.getByRole("button", { name: "Show link" }).click()
    const link = await sender.page.inputValue("#link")

    await recipient.page.goto(link)
    await waitForStatus(recipient.page, ["reviewing", "failed"])
    const offered = await recipient.page.locator(".file-list .name").allTextContents()
    check(
      JSON.stringify(offered) === JSON.stringify(["photo.png", "packing list.txt", "page.html"]),
      "rename: the recipient is offered the sender's new name",
      offered,
    )
    await recipient.page.getByRole("button", { name: "Rename photo.png" }).click()
    await recipient.page.getByRole("textbox", { name: "New name for photo.png" }).fill("holiday.png")
    await recipient.page.getByRole("button", { name: "Save" }).click()
    await recipient.page.getByRole("button", { name: "Accept", exact: true }).click()
    await waitForStatus(recipient.page, ["complete", "failed"])
    check((await status(recipient.page)) === "complete", "rename: a renamed offer still completes")

    const download = await recipient.page.getByRole("link", { name: "Save holiday.png" }).getAttribute("download")
    check(download === "holiday.png", "rename: the recipient saves a file under the name it chose", download ?? "none")
    const hashes = await recipient.page.evaluate(async () => await window.fileTransferTest?.fileHashes())
    check(JSON.stringify(hashes) === JSON.stringify(files.map((file) => sha256(file.buffer))), "rename: renaming changes no file's contents", hashes)

    await recipient.page.getByRole("button", { name: "Preview holiday.png" }).click()
    await previewFrame(recipient.page).locator("img").waitFor({ timeout: 10_000 })

    const receivedWidth = await previewFrame(recipient.page)
      .locator("img")
      .evaluate((image: HTMLImageElement) => image.naturalWidth)

    check(receivedWidth === 64, "preview: the recipient previews a received image", String(receivedWidth))
    await closePreview(recipient.page)

    // Opened on its own, the preview page must still have an opaque origin (the `sandbox` header in public/_headers).
    await recipient.page.goto(`${base}/preview.html`)
    const standaloneOrigin = await recipient.page.evaluate(() => window.origin)
    check(standaloneOrigin === "null", "preview: the preview page is sandboxed even when opened on its own", standaloneOrigin)

    check(sender.errors.length === 0 && recipient.errors.length === 0, "preview: no uncaught page errors", [...sender.errors, ...recipient.errors])
  } finally {
    await sender.close()
    await recipient.close()
  }
}

/** The admin token the local server runs with; never a real instance's. */
const localAdminToken = "end-to-end-admin-token"

/**
 * The operator page (src/admin.ts) against the local server, after the transfers above: a wrong token is refused, the
 * right one shows the counts and draws the chart, and the page ships nothing that identifies a transfer.
 */
const operatorPage = async (browser: Browser, base: string) => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))

  try {
    await page.goto(`${base}/admin`)
    await page.getByText("Counting").first().waitFor()
    await page.getByLabel("Admin token").fill("not-the-token")
    await page.getByRole("button", { name: "Show counts" }).click()
    await page.getByText("That token is not this instance's admin token.").waitFor({ timeout: 10_000 })
    check(true, "operator: a wrong admin token is refused")
    await page.getByLabel("Admin token").fill(localAdminToken)
    await page.getByRole("button", { name: "Show counts" }).click()
    await page.locator(".admin-chart canvas").first().waitFor({ timeout: 10_000 })
    const totals = await page.locator(".table-wrap table").textContent()
    check(/rooms created\s*[1-9]/iu.test(totals ?? ""), "operator: the right token shows the counts and draws the chart", totals ?? "")
    check(errors.length === 0, "operator: no uncaught page errors", errors)
  } finally {
    await page.close()
  }
}

/** Megabytes per second of the last completed transfer, for the latency suite's table. */
let lastMegabytesPerSecond = 0

const transfer = async (browser: Browser, base: string, scenario: TransferScenario) => {
  const files = payload(payloadSizes[scenario])

  const total = files.reduce((sum, file) => sum + file.buffer.length, 0)
  // Playwright copies every routed frame through its own protocol, so throughput runs without routing.
  const routed = scenario !== "throughput" && scenario !== "latency"
  // Resume runs on the relay alone, so the relay's own recovery stays covered; the others may go direct.
  // E2E_DIRECT=0 keeps every scenario on the relay, to compare the two paths.
  const direct = process.env.E2E_DIRECT !== "0" && scenario !== "resume" && scenario !== "latency"
  const sender = await openPage(browser, routed, false, direct)
  const recipient = await openPage(browser, routed, false, direct)

  try {
    const link = await offer(sender.page, base, files)

    if (scenario === "resume") {
      // As Chrome on Android reports a phone on mobile data (Network Information API).
      await recipient.page.addInitScript(() => {
        Object.defineProperty(navigator, "connection", { value: { type: "cellular" }, configurable: true })
      })
    }

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

    if (scenario === "resume") {
      check(
        await recipient.page.getByRole("button", { name: /^Accept and download .+ on mobile data$/u }).isVisible(),
        "resume: on mobile data, Accept states the size and asks for confirmation",
      )
    }

    await recipient.page.getByRole("button", { name: /^Accept(?: and download .+ on mobile data)?$/u }).click()
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

    const wentDirect = [
      await sender.page.evaluate(() => window.fileTransferTest?.wentDirect()),
      await recipient.page.evaluate(() => window.fileTransferTest?.wentDirect()),
    ]

    if (!direct) {
      check(
        wentDirect.every((value) => value === false),
        `${scenario}: with direct connections turned off, everything goes through the relay`,
        JSON.stringify(wentDirect),
      )
    } else if (scenario === "basic" && browserName === "chromium") {
      check(
        wentDirect.every((value) => value === true),
        `${scenario}: the browsers connect directly`,
        JSON.stringify(wentDirect),
      )
    } else {
      console.log(`   ${scenario}: direct path ${wentDirect.every((value) => value === true) ? "used" : "not used"}`)
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

    if (scenario === "basic") {
      await checkStorageClearing(recipient.page, base)
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
    await recipient.page.getByRole("button", { name: "Decline", exact: true }).click()
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
    await sender.page.getByRole("button", { name: "Seal parcel and create link" }).click()
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
        await privateWindow.page.getByRole("button", { name: "Accept", exact: true }).isDisabled(),
        "large: a private window that cannot hold the files is warned and cannot accept",
      )
    }

    await privateWindow.close()
    await recipient.page.goto(link)
    await waitForStatus(recipient.page, ["reviewing", "failed"])
    await recipient.page.getByRole("button", { name: "Accept", exact: true }).click()
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

/** Strikes one planned fault on a side's current socket or direct path. */
const applyFault = async (page: Page, observed: Observed, fault: Fault) => {
  const socket = observed.sockets.at(-1)

  if (socket === undefined) {
    throw new Error("no socket to fault")
  }

  switch (fault.kind) {
    case "cut-clean":
    case "cut-half-open": {
      await cutSocket(observed, fault.kind === "cut-clean" ? "clean" : "half-open")
      break
    }

    case "stall": {
      socket.faults.pausedUntil = Date.now() + fault.milliseconds
      break
    }

    case "blackhole": {
      socket.faults.blackholed = true
      break
    }

    case "latency": {
      socket.faults.latency = fault.milliseconds
      break
    }

    case "replay": {
      for (let index = 0; index < fault.frames && socket.fromServer.length > 0; index++) {
        const frame = socket.fromServer[Math.floor(Math.random() * socket.fromServer.length)]

        if (frame !== undefined) {
          socket.page.send(frame)
        }
      }

      break
    }

    case "direct-drop": {
      await page.evaluate(() => window.chaosDropDirect?.())
      break
    }
  }
}

/** Time a chaos run may take: a silent socket has to be noticed and replaced, which takes tens of seconds. */
const chaosTimeoutMilliseconds = Number(process.env.E2E_CHAOS_TIMEOUT_MS ?? 120_000)

/**
 * One chaos run (faultPlan.ts): a transfer of 24 MB in two files, with the plan's faults struck as the recipient's
 * progress passes each point. It must still end with both sides complete, every file byte-identical, and no page
 * error; a failure prints the plan, whose seed replays it.
 */
const chaosRun = async (browser: Browser, base: string, plan: FaultPlan) => {
  console.log(describePlan(plan))

  const files = payload([
    ["kilo-dataset.bin", 24 * 1024 * 1024 + 7],
    ["lima-notes.txt", 7000],
  ])

  const sender = await openPage(browser, true, false, plan.direct, true)
  const recipient = await openPage(browser, true, false, plan.direct, true)
  const sides: Readonly<Record<Side, typeof sender>> = { sender, recipient }
  const label = `chaos seed ${plan.seed}`

  try {
    const link = await offer(sender.page, base, files)
    await recipient.page.goto(link)
    await waitForStatus(recipient.page, ["reviewing", "failed"], chaosTimeoutMilliseconds)
    await recipient.page.getByRole("button", { name: /^Accept/u }).click()

    for (const { at, side, fault } of plan.faults) {
      await recipient.page.waitForFunction(
        (wanted) => {
          const progress = window.fileTransferTest?.progress()

          return window.fileTransferTest?.status() === "complete" || (progress !== undefined && progress.total > 0 && progress.done / progress.total >= wanted)
        },
        at,
        { timeout: chaosTimeoutMilliseconds },
      )
      await applyFault(sides[side].page, sides[side].observed, fault)
    }

    await waitForStatus(recipient.page, ["complete", "failed"], chaosTimeoutMilliseconds)
    await waitForStatus(sender.page, ["complete", "failed"], chaosTimeoutMilliseconds)
    check((await status(recipient.page)) === "complete" && (await status(sender.page)) === "complete", `${label}: both sides complete`, {
      recipient: await recipient.page.evaluate(() => window.fileTransferTest?.failure()),
      sender: await sender.page.evaluate(() => window.fileTransferTest?.failure()),
    })
    const hashes = await recipient.page.evaluate(async () => await window.fileTransferTest?.fileHashes())
    check(JSON.stringify(hashes) === JSON.stringify(files.map((file) => sha256(file.buffer))), `${label}: every file arrives byte-identical`, hashes)
    check(sender.errors.length === 0 && recipient.errors.length === 0, `${label}: no uncaught page errors`, [...sender.errors, ...recipient.errors])
  } catch (error) {
    console.log(`   ${label} failed; replay it with E2E_SUITE=chaos E2E_SEED=${plan.seed} E2E_RUNS=1`)
    console.log(`   ${await describe("sender", sender.page, sender.observed)}\n   ${await describe("recipient", recipient.page, recipient.observed)}`)
    throw error
  } finally {
    await sender.close()
    await recipient.close()
  }
}

/** `E2E_RUNS` chaos runs (default 6) from seed `E2E_SEED` onwards (default random, printed). */
/** connection.ts's `joinLimitMilliseconds`; the script does not import browser code. */
const joinLimitMilliseconds = 15_000

/**
 * A recipient whose first socket opens but whose join the network loses (the socket starts blackholed) gives it up
 * after `joinLimitMilliseconds` and joins on a new socket, so it still reaches the offer (docs/spikes/0006, C1).
 */
const unansweredJoin = async (browser: Browser, base: string) => {
  const sender = await openPage(browser, false)
  const recipient = await openPage(browser, true)

  try {
    const link = await offer(sender.page, base, payload([["mike-join.txt", 4000]]))
    recipient.observed.silentSockets = 1
    await recipient.page.goto(link)
    await waitForStatus(recipient.page, ["reviewing", "failed"], joinLimitMilliseconds + 20_000).catch(() => undefined)
    check((await status(recipient.page)) === "reviewing", "a join the room never answers is given up, and the recipient joins again and sees the offer", {
      status: await status(recipient.page),
      sockets: recipient.observed.sockets.length,
    })
    check(recipient.observed.sockets.length >= 2, "the unanswered socket was replaced by a new one", `${recipient.observed.sockets.length} sockets`)
  } finally {
    await sender.close()
    await recipient.close()
  }
}

const chaos = async (browser: Browser, base: string) => {
  await unansweredJoin(browser, base)
  const seed = Number(process.env.E2E_SEED ?? Math.floor(Math.random() * 2 ** 31))
  const runs = Number(process.env.E2E_RUNS ?? 6)
  console.log(`chaos: seeds ${seed} to ${seed + runs - 1}`)

  for (let index = 0; index < runs; index++) {
    await chaosRun(browser, base, faultPlan(seed + index))
  }
}

/** A network situation for the lab suite (networkLab.ts): both routers' NATs and impairments, and an event. */
interface LabScenario {
  readonly name: string
  readonly nat: Readonly<Record<LabSide, NatBehaviour>>
  readonly impairment?: Partial<Readonly<Record<LabSide, Impairment>>>
  /** Struck when the recipient's progress passes `at`: a blackhole for `seconds`, or a move to a new address. */
  readonly event?: { readonly at: number; readonly side: LabSide; readonly kind: "blackhole" | "move"; readonly seconds?: number }
  /** The path the transfer must take, when the NATs decide it. */
  readonly expectedPath?: "direct" | "relay"
  readonly needsNetem?: boolean
  /** Megabytes to send; default 16. */
  readonly megabytes?: number
}

/** A home connection: 40 Mbit/s each way, so a transfer lasts long enough for a direct path to open and take over. */
const broadband: Impairment = { rateMegabits: 40 }

/** Applied at the router in each direction, so the round trip grows by twice the delay. */
const mobileData: Impairment = { delayMilliseconds: 40, lossPercent: 1, rateMegabits: 20 }
const badLink: Impairment = { delayMilliseconds: 100, lossPercent: 3 }

/** The sender sits behind router a, the recipient behind router b. */
const labScenarios: readonly LabScenario[] = [
  // A direct path through NAT takes a second or two to open, and a small transfer on a fast relay is done by then, so
  // this one is long enough to start on the relay and move to the direct path.
  { name: "open NATs", nat: { a: "open", b: "open" }, impairment: { a: broadband, b: broadband }, megabytes: 48, expectedPath: "direct" },
  { name: "symmetric NATs", nat: { a: "symmetric", b: "symmetric" }, expectedPath: "relay" },
  { name: "one symmetric NAT", nat: { a: "open", b: "symmetric" } },
  { name: "UDP blocked at the sender", nat: { a: "udp-blocked", b: "open" }, expectedPath: "relay" },
  { name: "8 Mbit/s uplink", nat: { a: "open", b: "open" }, impairment: { a: { rateMegabits: 8 } } },
  // The recipient on a mobile-like link: its router adds 40 ms each way and drops 1% each way. No jitter: netem's
  // jitter reorders packets far more than real networks do. Run twice, direct and relay only, to compare the paths.
  { name: "mobile data (80 ms more round trip, 1% loss, 20 Mbit/s)", nat: { a: "open", b: "open" }, impairment: { b: mobileData }, needsNetem: true },
  {
    name: "mobile data (80 ms more round trip, 1% loss, 20 Mbit/s), relay only",
    nat: { a: "symmetric", b: "symmetric" },
    impairment: { b: mobileData },
    needsNetem: true,
  },
  // A poor link: 200 ms more round trip and 3% loss each way; slow by nature (about 60 KB/s for TCP by Mathis'
  // estimate), so 4 MB, which must still arrive whole.
  { name: "bad link (200 ms more round trip, 3% loss)", nat: { a: "open", b: "open" }, impairment: { b: badLink }, megabytes: 4, needsNetem: true },
  {
    name: "bad link (200 ms more round trip, 3% loss), relay only",
    nat: { a: "symmetric", b: "symmetric" },
    impairment: { b: badLink },
    megabytes: 4,
    needsNetem: true,
  },
  { name: "sender's router drops everything for 30 s", nat: { a: "open", b: "open" }, event: { at: 0.3, side: "a", kind: "blackhole", seconds: 30 } },
  { name: "recipient's router moves to a new address", nat: { a: "open", b: "open" }, event: { at: 0.3, side: "b", kind: "move" } },
  {
    name: "sender's router drops everything for 30 s, relay only",
    nat: { a: "symmetric", b: "symmetric" },
    event: { at: 0.3, side: "a", kind: "blackhole", seconds: 30 },
  },
]

/** The self-hosted node on the lab's internet, with the lab's STUN server; built first, app included. */
const startLabServer = async () => {
  for (const directory of [appDirectory, selfHostedDirectory]) {
    const built = Bun.spawnSync([process.execPath, "run", "build"], { cwd: directory, stdout: "ignore", stderr: "pipe" })

    if (built.exitCode !== 0) {
      throw new Error(`build in ${directory} failed:\n${built.stderr.toString()}`)
    }
  }

  const port = labPort
  const storage = mkdtempSync(nodePath.join(tmpdir(), "file-transfer-lab-"))

  const stun = Bun.spawn(
    [
      "turnserver",
      "--stun-only",
      "--listening-ip",
      serverAddress,
      "--listening-port",
      "3478",
      "--no-cli",
      "--no-tls",
      "--no-dtls",
      "--log-file",
      "stdout",
      "--simple-log",
    ],
    { stdout: "ignore", stderr: "ignore" },
  )

  const node = Bun.spawn(
    [
      nodePath.join(selfHostedDirectory, "node_modules/.bin/workerd"),
      "serve",
      "workerd.capnp",
      `--socket-addr=http=${serverAddress}:${port}`,
      `--directory-path=storage=${storage}`,
    ],
    {
      cwd: selfHostedDirectory,
      env: { ...process.env, LIMIT_ROOMS_PER_ADDRESS_PER_HOUR: "100000", STUN_URLS: `stun:${serverAddress}:3478` },
      stdout: "ignore",
      stderr: "inherit",
    },
  )

  for (let attempt = 0; attempt < 60; attempt++) {
    const answer = await fetch(`http://${serverAddress}:${port}/api/instance`).catch(() => undefined)

    if (answer?.ok === true) {
      return {
        port,
        stop: () => {
          node.kill()
          stun.kill()
          rmSync(storage, { recursive: true, force: true })
        },
      }
    }

    await Bun.sleep(500)
  }

  node.kill()
  stun.kill()
  throw new Error("the lab's node did not start within 30 s")
}

/** One lab transfer, 16 MB unless the scenario says otherwise, in two files from home a to home b under its network. */
const labTransfer = async (senderBrowser: Browser, recipientBrowser: Browser, scenario: LabScenario) => {
  for (const side of ["a", "b"] as const) {
    setNat(side, scenario.nat[side])
    impair(side, scenario.impairment?.[side])
  }

  const files = payload([
    ["mike-capture.bin", (scenario.megabytes ?? 16) * 1024 * 1024 + 11],
    ["november-notes.txt", 9000],
  ])

  const total = files.reduce((sum, file) => sum + file.buffer.length, 0)
  const sender = await openPage(senderBrowser, false, false, true, true)
  const recipient = await openPage(recipientBrowser, false, false, true, true)
  const label = `lab ${scenario.name}`
  let restore: (() => void) | undefined

  try {
    const link = await offer(sender.page, labOrigin, files)
    await recipient.page.goto(link)
    await waitForStatus(recipient.page, ["reviewing", "failed"])
    await recipient.page.getByRole("button", { name: /^Accept/u }).click()
    const started = performance.now()
    const { event } = scenario

    if (event !== undefined) {
      await waitForProgress(recipient.page, event.at)

      if (event.kind === "blackhole") {
        blackhole(event.side, true)

        const timer = setTimeout(
          () => {
            blackhole(event.side, false)
          },
          (event.seconds ?? 30) * 1000,
        )

        restore = () => {
          clearTimeout(timer)
          blackhole(event.side, false)
        }
      } else {
        moveRouter(event.side, true)
        restore = () => {
          moveRouter(event.side, false)
        }
      }
    }

    await waitForStatus(recipient.page, ["complete", "failed"])
    await waitForStatus(sender.page, ["complete", "failed"])
    const seconds = (performance.now() - started) / 1000
    check((await status(recipient.page)) === "complete" && (await status(sender.page)) === "complete", `${label}: both sides complete`, {
      recipient: await recipient.page.evaluate(() => window.fileTransferTest?.failure()),
      sender: await sender.page.evaluate(() => window.fileTransferTest?.failure()),
    })
    const hashes = await recipient.page.evaluate(async () => await window.fileTransferTest?.fileHashes())
    check(JSON.stringify(hashes) === JSON.stringify(files.map((file) => sha256(file.buffer))), `${label}: every file arrives byte-identical`, hashes)
    check(sender.errors.length === 0 && recipient.errors.length === 0, `${label}: no uncaught page errors`, [...sender.errors, ...recipient.errors])
    const wentDirect = (await sender.page.evaluate(() => window.fileTransferTest?.wentDirect())) === true
    const path = wentDirect ? "direct" : "relay"

    if (scenario.expectedPath !== undefined && path !== scenario.expectedPath) {
      console.log(`   sender's peer connections:\n     ${((await sender.page.evaluate(() => window.peerStates)) ?? []).join("\n     ")}`)
      console.log(`   recipient's peer connections:\n     ${((await recipient.page.evaluate(() => window.peerStates)) ?? []).join("\n     ")}`)
    }

    // Firefox's direct path fails in this lab on GitHub's runners only: the answering side starts gathering and
    // never yields a candidate (docs/spikes/0005-unreliable-networks.md, open questions). It still has to complete
    // and arrive whole above; its path is reported, and asserted on Chromium.
    const directIsAsserted = scenario.expectedPath === "relay" || browserName === "chromium"

    if (scenario.expectedPath !== undefined && directIsAsserted) {
      check(path === scenario.expectedPath, `${label}: goes ${scenario.expectedPath}`, path)
    }

    console.log(
      JSON.stringify({
        lab: scenario.name,
        browser: browserName,
        path,
        seconds: Math.round(seconds * 10) / 10,
        megabytesPerSecond: Math.round((total / 1e6 / seconds) * 10) / 10,
      }),
    )
  } finally {
    restore?.()
    await sender.close()
    await recipient.close()
  }
}

/**
 * The origin both pages load from: the lab's node itself, which each browser is told to treat as a secure context
 * (Chromium's `--unsafely-treat-insecure-origin-as-secure`, Firefox's `dom.securecontext.allowlist`). Not localhost:
 * Firefox gathers no usable ICE candidates on a localhost page, so its direct path would fail for a reason no real
 * page has.
 */
const labPort = 8787
const labOrigin = `http://${serverAddress}:${labPort}`

const labLaunchOptions = (): LaunchOptions =>
  browserName === "firefox"
    ? { firefoxUserPrefs: { ...launchOptions.firefoxUserPrefs, "dom.securecontext.allowlist": serverAddress } }
    : { args: [...(launchOptions.args ?? []), `--unsafely-treat-insecure-origin-as-secure=${labOrigin}`] }

/**
 * The lab suite: transfers between two homes behind emulated routers (networkLab.ts). Needs root and Linux; skips
 * the netem scenarios when the kernel lacks netem. Chromium and Firefox only: WebKit's persistent profiles do not take
 * a launch wrapper.
 */
const lab = async () => {
  check(process.getuid?.() === 0, "the lab suite runs as root (it builds network namespaces)")
  check(browserName !== "webkit", "the lab suite runs in chromium or firefox")
  const scratch = mkdtempSync(nodePath.join(tmpdir(), "file-transfer-lab-browsers-"))
  buildLab()
  const server = await startLabServer()
  const browsers: Browser[] = []

  // A killed run must not leave the node, the STUN server or the namespaces behind for the next one.
  const stopLab = () => {
    server.stop()
    tearDownLab()
  }

  const onSignal = () => {
    stopLab()
    process.exit(130)
  }

  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  try {
    const netem = hasNetem()
    const only = process.env.E2E_LAB_ONLY

    const launchIn = async (side: LabSide) => {
      const launched = await browserType.launch({ ...labLaunchOptions(), executablePath: browserInHome(side, browserType.executablePath(), scratch) })
      browsers.push(launched)

      return launched
    }

    const senderBrowser = await launchIn("a")
    const recipientBrowser = await launchIn("b")

    for (const scenario of labScenarios) {
      if (only !== undefined && !scenario.name.includes(only)) {
        continue
      }

      if (scenario.needsNetem === true && !netem) {
        console.log(`skip lab ${scenario.name}: this kernel has no netem`)
        continue
      }

      await labTransfer(senderBrowser, recipientBrowser, scenario)
    }
  } finally {
    for (const browser of browsers) {
      await browser.close()
    }

    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    stopLab()
    rmSync(scratch, { recursive: true, force: true })
  }
}

const local = configuredBase === undefined && suite !== "lab" ? await startLocalServer() : undefined
const base = configuredBase ?? local?.origin ?? ""

console.log(`end to end against ${base} in ${browserName}, suite ${suite}`)

const browser = await browserType.launch(launchOptions)

try {
  if (suite === "large") {
    await large(browser, base)
  } else if (suite === "lab") {
    await lab()
  } else if (suite === "chaos") {
    await chaos(browser, base)
  } else if (suite === "scenario") {
    const scenario = process.env.E2E_SCENARIO ?? "half-open"
    const repeats = Number(process.env.E2E_REPEAT ?? 10)

    if (!isTransferScenario(scenario)) {
      throw new Error(`E2E_SCENARIO must be one of ${transferScenarios.join(", ")}, not ${scenario}`)
    }

    for (let run = 1; run <= repeats; run++) {
      console.log(`run ${run} of ${repeats}`)
      await transfer(browser, base, scenario)
    }
  } else if (suite === "latency") {
    check(local !== undefined, "the latency suite runs against the local server only")
    await latency(browser, base)
  } else {
    const page = await browser.newPage()
    const response = await page.goto(`${base}/r/some-room`)
    check(response?.ok() === true, "a recipient link path serves the app", `status ${response?.status() ?? "none"}`)
    await page.close()
    await transfer(browser, base, "basic")
    await previewsAndNames(browser, base)
    await transfer(browser, base, "resume")

    if (process.env.E2E_HALF_OPEN !== "0") {
      await transfer(browser, base, "half-open")
    }

    await transfer(browser, base, "throughput")
    await decline(browser, base)
    await wrongKey(browser, base)

    if (local !== undefined) {
      await operatorPage(browser, base)
    }
  }

  console.log(`\nall ${passed} checks passed`)
} finally {
  await browser.close()
  await local?.stop()
  rmSync(payloadDirectory, { recursive: true, force: true })
}
