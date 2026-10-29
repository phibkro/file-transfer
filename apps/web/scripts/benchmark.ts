/**
 * Benchmarks (docs/spikes/0004-transfer-benchmarks.md), run against the self-hosted platform so they never touch a
 * Cloudflare account: plain workerd on this machine, started here unless BASE_URL names a running node. wrangler dev is
 * not used, because Miniflare compresses WebSocket frames (spike 0001) and would misstate the relay.
 *
 *   bun scripts/benchmark.ts            both benchmarks
 *   BENCH=crypto bun scripts/benchmark.ts
 *   BENCH=transfer bun scripts/benchmark.ts
 *
 * Settings (environment variables):
 *   BENCH_BROWSERS   chromium,firefox,webkit (default chromium)
 *   BENCH_SIZES      transfer sizes in MB (default 1,16,128)
 *   BENCH_REPEATS    transfers per size and path; the median is reported (default 3)
 *   BENCH_EXPONENTS  record size exponents for the crypto benchmark (default 12,14,16,17,18,20,22)
 *   BENCH_OUTPUT     a file for the results as JSON lines (default: none)
 *   BASE_URL         a running self-hosted node instead of starting one
 *
 * The crypto benchmark measures what each record costs a browser with and without encryption (cryptoBenchmarkPage.ts).
 * The transfer benchmark sends files of each size from one page to another, through the relay and directly, and
 * reports the sealing time (the labelling pass before the link exists) and the transfer rate after Accept.
 */
import { randomBytes } from "node:crypto"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import { chromium, firefox, webkit } from "playwright"
import type { Browser, BrowserContext, BrowserType, LaunchOptions, Page } from "playwright"
import type { CryptoRow } from "./cryptoBenchmarkPage.ts"

const appDirectory = nodePath.join(import.meta.dirname, "..")
const selfHostedDirectory = nodePath.join(appDirectory, "../../platforms/self-hosted")
const which = process.env.BENCH ?? "all"
const browserNames = (process.env.BENCH_BROWSERS ?? "chromium").split(",").map((name) => name.trim())
const sizesInMegabytes = (process.env.BENCH_SIZES ?? "1,16,128").split(",").map(Number)
const repeats = Number(process.env.BENCH_REPEATS ?? 3)
const exponents = (process.env.BENCH_EXPONENTS ?? "12,14,16,17,18,20,22").split(",").map(Number)
const output = process.env.BENCH_OUTPUT

const browserTypes = new Map<string, BrowserType>([
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
])

// Two pages on one machine connect directly through host candidates, which browsers hide behind mDNS names.
const launchOptionsFor = (name: string): LaunchOptions =>
  new Map<string, LaunchOptions>([
    ["chromium", { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] }],
    ["firefox", { firefoxUserPrefs: { "media.peerconnection.ice.obfuscate_host_addresses": false } }],
  ]).get(name) ?? {}

type ResultValue = string | number | boolean

const record = (row: Readonly<Record<string, ResultValue>>) => {
  const line = JSON.stringify({ ...row, at: new Date().toISOString() })
  console.log(line)

  if (output !== undefined) {
    appendFileSync(output, `${line}\n`)
  }
}

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/** Plain workerd running the self-hosted platform, built first, with limits loose enough for many rooms. */
const startNode = async () => {
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: selfHostedDirectory, stdout: "ignore", stderr: "pipe" })

  if (build.exitCode !== 0) {
    throw new Error(`self-hosted build failed:\n${build.stderr.toString()}`)
  }

  const port = 22_000 + Math.floor(Math.random() * 20_000)
  const storage = mkdtempSync(nodePath.join(tmpdir(), "file-transfer-bench-"))

  const node = Bun.spawn(
    [
      nodePath.join(selfHostedDirectory, "node_modules/.bin/workerd"),
      "serve",
      "workerd.capnp",
      `--socket-addr=http=127.0.0.1:${port}`,
      `--directory-path=storage=${storage}`,
    ],
    {
      cwd: selfHostedDirectory,
      env: { ...process.env, LIMIT_ROOMS_PER_ADDRESS_PER_HOUR: "100000", STUN_URLS: "none" },
      stdout: "ignore",
      stderr: "inherit",
    },
  )

  const origin = `http://127.0.0.1:${port}`

  for (let attempt = 0; attempt < 60; attempt++) {
    const answer = await fetch(`${origin}/api/instance`).catch(() => undefined)

    if (answer?.ok === true) {
      return {
        origin,
        stop: () => {
          node.kill()
          rmSync(storage, { recursive: true, force: true })
        },
      }
    }

    await Bun.sleep(500)
  }

  node.kill()
  throw new Error("the self-hosted node did not start")
}

const cryptoBundle = async (): Promise<string> => {
  const built = await Bun.build({ entrypoints: [nodePath.join(import.meta.dirname, "cryptoBenchmarkPage.ts")], target: "browser", minify: false })
  const [artifact] = built.outputs

  if (!built.success || artifact === undefined) {
    throw new Error(`could not bundle the crypto benchmark: ${built.logs.map(String).join("\n")}`)
  }

  return await artifact.text()
}

/** The crypto benchmark in one browser, on a blank page with a secure origin (localhost) and no content policy. */
const cryptoInBrowser = async (browser: Browser, name: string, bundle: string) => {
  const page = await browser.newPage()

  try {
    await page.route("http://localhost/bench", async (route) => {
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>bench</title>" })
    })
    await page.goto("http://localhost/bench")
    await page.addScriptTag({ content: bundle, type: "module" })
    await page.waitForFunction(() => window.runCryptoBenchmark !== undefined)
    const rows = await page.evaluate(async ([list, bytes]) => (await window.runCryptoBenchmark?.(list, bytes)) ?? [], [exponents, 64 * 1024 * 1024] as const)

    for (const row of rows) {
      record({ benchmark: "crypto", engine: name, ...row })
    }
  } finally {
    await page.close()
  }
}

/** The same measurement in Bun (BoringSSL), for comparison with the browsers. */
const cryptoInBun = async () => {
  Object.assign(globalThis, { window: globalThis })
  await import("./cryptoBenchmarkPage.ts")
  const rows: readonly CryptoRow[] = (await globalThis.window.runCryptoBenchmark?.(exponents, 64 * 1024 * 1024)) ?? []

  for (const row of rows) {
    record({ benchmark: "crypto", engine: `bun ${Bun.version}`, ...row })
  }
}

const status = async (page: Page) => await page.evaluate(() => window.fileTransferTest?.status())

const waitFor = async (page: Page, wanted: readonly string[], timeout: number) => {
  await page.waitForFunction((list) => list.includes(window.fileTransferTest?.status() ?? ""), wanted, { timeout, polling: 100 })
}

/** One transfer of `file` from a fresh sender page to a fresh recipient page; times are in seconds. */
/**
 * A fresh profile for one page. WebKit offers the origin-private file system only in a persistent profile (its
 * ephemeral contexts count as private browsing), so it gets a temporary profile directory, as in endToEnd.ts.
 */
type ContextFactory = () => Promise<{ readonly context: BrowserContext; readonly dispose: () => void }>

const contextFactoryFor =
  (browser: Browser, browserType: BrowserType, name: string): ContextFactory =>
  async () => {
    if (name !== "webkit") {
      return { context: await browser.newContext(), dispose: () => undefined }
    }

    const directory = mkdtempSync(nodePath.join(tmpdir(), "file-transfer-bench-webkit-"))

    return {
      context: await browserType.launchPersistentContext(directory, launchOptionsFor(name)),
      dispose: () => {
        rmSync(directory, { recursive: true, force: true })
      },
    }
  }

const transferOnce = async (newContext: ContextFactory, origin: string, file: string, bytes: number, direct: boolean) => {
  const openPage = async () => {
    const { context, dispose } = await newContext()

    if (!direct) {
      await context.addInitScript(() => {
        localStorage.setItem("file-transfer:direct-connections", "off")
      })
    }

    return { context, dispose, page: await context.newPage() }
  }

  const sender = await openPage()
  const recipient = await openPage()
  const timeout = Math.max(60_000, (bytes / 1e6) * 2000)

  try {
    await sender.page.goto(`${origin}/`)
    await sender.page.setInputFiles("#files", file)
    const sealingStarted = performance.now()
    await sender.page.getByRole("button", { name: "Seal parcel and create link" }).click()
    await waitFor(sender.page, ["waiting-for-recipient", "failed"], timeout)
    const sealingSeconds = (performance.now() - sealingStarted) / 1000
    await sender.page.getByRole("button", { name: "Show link" }).click()
    const link = await sender.page.inputValue("#link")
    await recipient.page.goto(link)
    await waitFor(recipient.page, ["reviewing", "failed"], 60_000)
    const transferStarted = performance.now()
    await recipient.page.getByRole("button", { name: /^Accept/u }).click()
    await waitFor(recipient.page, ["complete", "failed"], timeout)
    const transferSeconds = (performance.now() - transferStarted) / 1000
    const complete = (await status(recipient.page)) === "complete"
    const sizes = await recipient.page.evaluate(() => window.fileTransferTest?.fileSizes() ?? [])
    const wentDirect = await recipient.page.evaluate(() => window.fileTransferTest?.wentDirect() ?? false)

    return { complete: complete && sizes[0] === bytes, sealingSeconds, transferSeconds, wentDirect }
  } finally {
    await sender.context.close()
    await recipient.context.close()
    sender.dispose()
    recipient.dispose()
  }
}

const transfers = async (newContext: ContextFactory, name: string, origin: string, directory: string) => {
  for (const megabytes of sizesInMegabytes) {
    const bytes = Math.round(megabytes * 1e6)
    const file = nodePath.join(directory, `bench-${megabytes}mb.bin`)
    writeFileSync(file, randomBytes(bytes))

    for (const path of ["relay", "direct"] as const) {
      const runs = []

      for (let run = 0; run < repeats; run++) {
        runs.push(await transferOnce(newContext, origin, file, bytes, path === "direct"))
      }

      const complete = runs.filter((run) => run.complete)
      record({
        benchmark: "transfer",
        engine: name,
        megabytes,
        path,
        runs: runs.length,
        complete: complete.length,
        wentDirect: complete.filter((run) => run.wentDirect).length,
        sealingMegabytesPerSecond: Math.round((megabytes / median(complete.map((run) => run.sealingSeconds))) * 10) / 10,
        transferMegabytesPerSecond: Math.round((megabytes / median(complete.map((run) => run.transferSeconds))) * 10) / 10,
        transferSecondsMedian: Math.round(median(complete.map((run) => run.transferSeconds)) * 100) / 100,
      })
    }

    rmSync(file, { force: true })
  }
}

const node = which === "crypto" || process.env.BASE_URL !== undefined ? undefined : await startNode()
const origin = process.env.BASE_URL ?? node?.origin ?? ""
const directory = mkdtempSync(nodePath.join(tmpdir(), "file-transfer-bench-files-"))

try {
  if (which !== "transfer") {
    await cryptoInBun()
  }

  const bundle = which === "transfer" ? "" : await cryptoBundle()

  for (const name of browserNames) {
    const browserType = browserTypes.get(name)

    if (browserType === undefined) {
      throw new Error(`unknown browser ${name}`)
    }

    const browser = await browserType.launch(launchOptionsFor(name))
    const engine = `${name} ${browser.version()}`

    try {
      if (which !== "transfer") {
        await cryptoInBrowser(browser, engine, bundle)
      }

      if (which !== "crypto") {
        await transfers(contextFactoryFor(browser, browserType, name), engine, origin, directory)
      }
    } finally {
      await browser.close()
    }
  }
} finally {
  node?.stop()
  rmSync(directory, { recursive: true, force: true })
}
