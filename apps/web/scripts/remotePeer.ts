/**
 * One side of a transfer between two machines (.github/workflows/two-machines.yml): the sender offers a payload and
 * writes the link to a file, the recipient reads it and receives. Both derive the payload from the same seed, so the
 * recipient checks every byte without the sender sending it any hash. Prints one JSON line with the outcome.
 *
 *   PEER_ROLE      sender or recipient
 *   BASE_URL       the node both use (a workers.dev address: the zone answers GitHub's runners with 403)
 *   PEER_SEED      seeds the payload (the workflow uses its run identifier)
 *   PEER_MEGABYTES payload size, default 256
 *   PEER_LINK_FILE where the sender writes the link and the recipient reads it
 *   E2E_BROWSER    chromium (default) or firefox
 *
 * The link carries its secret only in the fragment, as always; the workflow hands it from one job to the other as a
 * short-lived artifact and deletes it once read. The payload is random test data.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import { chromium, firefox } from "playwright"
import type { Page } from "playwright"
import { randomSource } from "./faultPlan.ts"

const role = process.env.PEER_ROLE
const base = process.env.BASE_URL
const seed = Number(process.env.PEER_SEED ?? 1)
const megabytes = Number(process.env.PEER_MEGABYTES ?? 256)
const linkFile = process.env.PEER_LINK_FILE
const browserName = process.env.E2E_BROWSER ?? "chromium"
const timeoutMilliseconds = 30 * 60 * 1000

if ((role !== "sender" && role !== "recipient") || base === undefined || linkFile === undefined) {
  throw new Error("set PEER_ROLE (sender or recipient), BASE_URL and PEER_LINK_FILE")
}

/** The payload: `megabytes` MiB of seeded pseudo-random bytes, the same on both machines. */
const payload = (): Uint8Array<ArrayBuffer> => {
  const random = randomSource(seed)
  const words = new Uint32Array((megabytes * 1024 * 1024) / 4)

  for (let index = 0; index < words.length; index++) {
    words[index] = Math.floor(random() * 4_294_967_296)
  }

  return new Uint8Array(words.buffer)
}

const expectedHash = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")

const status = async (page: Page) => await page.evaluate(() => window.fileTransferTest?.status())

const waitForStatus = async (page: Page, wanted: readonly string[]) =>
  await page.waitForFunction((statuses) => statuses.includes(window.fileTransferTest?.status() ?? ""), wanted, { timeout: timeoutMilliseconds, polling: 500 })

const report = async (page: Page, seconds: number) => {
  const outcome = {
    role,
    browser: browserName,
    megabytes,
    status: await status(page),
    path: (await page.evaluate(() => window.fileTransferTest?.wentDirect())) === true ? "direct" : "relay",
    seconds: Math.round(seconds * 10) / 10,
    megabytesPerSecond: Math.round(((megabytes * 1.048576) / seconds) * 10) / 10,
    failure: await page.evaluate(() => window.fileTransferTest?.failure()),
  }

  console.log(JSON.stringify(outcome))

  return outcome
}

const browser = await (browserName === "firefox" ? firefox : chromium).launch()
const scratch = mkdtempSync(nodePath.join(tmpdir(), "file-transfer-peer-"))

try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const bytes = payload()

  if (role === "sender") {
    const file = nodePath.join(scratch, "oscar-dataset.bin")
    writeFileSync(file, bytes)
    await page.goto(`${base}/`)
    await page.setInputFiles("#files", file)
    await page.getByRole("button", { name: "Seal parcel and create link" }).click()
    await waitForStatus(page, ["waiting-for-recipient", "failed"])
    await page.getByRole("button", { name: "Show link" }).click()
    writeFileSync(linkFile, await page.inputValue("#link"))
    console.log("link written; waiting for the recipient")
    await waitForStatus(page, ["transferring", "complete", "failed"])
    const started = performance.now()
    await waitForStatus(page, ["complete", "failed"])
    const outcome = await report(page, (performance.now() - started) / 1000)
    process.exitCode = outcome.status === "complete" ? 0 : 1
  } else {
    for (let waited = 0; !existsSync(linkFile); waited += 2) {
      if (waited > 900) {
        throw new Error("no link within 15 minutes")
      }

      await Bun.sleep(2000)
    }

    await page.goto(readFileSync(linkFile, "utf-8").trim())
    await waitForStatus(page, ["reviewing", "failed"])
    await page.getByRole("button", { name: /^Accept/u }).click()
    const started = performance.now()
    await waitForStatus(page, ["complete", "failed"])
    const outcome = await report(page, (performance.now() - started) / 1000)
    const hashes = await page.evaluate(async () => await window.fileTransferTest?.fileHashes())
    const identical = JSON.stringify(hashes) === JSON.stringify([await expectedHash(bytes)])
    console.log(identical ? "every byte arrived as sent" : `received different bytes: ${JSON.stringify(hashes)}`)
    process.exitCode = outcome.status === "complete" && identical ? 0 : 1
  }
} finally {
  await browser.close()
  rmSync(scratch, { recursive: true, force: true })
}
