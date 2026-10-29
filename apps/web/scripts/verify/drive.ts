/**
 * Drives one user journey against a running instance the way two people would, in two isolated browser profiles, and
 * writes the evidence (.claude/skills/verify-file-transfer, features/): a screenshot and an ARIA snapshot of each page
 * after each step, every socket frame and request URL the browsers sent, and `result.json` with each step's action
 * and observed outcome. Exits non-zero when the journey fails; the evidence stays either way.
 *
 *   bun apps/web/scripts/verify/drive.ts <journey> <origin> <evidence directory> [chromium | firefox | webkit]
 *
 * Journeys: send-receive, decline, wrong-key, resume.
 */
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import nodePath from "node:path"
import { chromium, firefox, webkit } from "playwright"
import type { Browser, Page, WebSocketRoute } from "playwright"

const journeys = ["send-receive", "decline", "wrong-key", "resume"] as const

type Journey = (typeof journeys)[number]

const isJourney = (value: string | undefined): value is Journey => journeys.some((journey) => journey === value)

const [journey, origin, evidenceRoot, browserName = "chromium"] = process.argv.slice(2)

if (!isJourney(journey) || origin === undefined || evidenceRoot === undefined) {
  console.error(`usage: bun apps/web/scripts/verify/drive.ts <${journeys.join(" | ")}> <origin> <evidence directory> [chromium | firefox | webkit]`)
  process.exit(2)
}

const evidence = nodePath.join(evidenceRoot, journey)

mkdirSync(evidence, { recursive: true })

interface Step {
  readonly action: string
  readonly observed: string
  readonly ok: boolean
}

const steps: Step[] = []
const sent: { readonly page: string; readonly kind: "url" | "frame"; readonly text: string }[] = []

const step = (action: string, observed: string, ok: boolean) => {
  steps.push({ action, observed, ok })
  console.log(`${ok ? "ok" : "NOT OK"} ${action}: ${observed}`)

  if (!ok) {
    throw new Error(`${action}: ${observed}`)
  }
}

const browserType = { chromium, firefox, webkit }[browserName] ?? chromium
const browser: Browser = await browserType.launch()

/** A fresh profile whose page records every request URL and every socket frame it sends, for the invariant check. */
const openProfile = async (label: string) => {
  const context = await browser.newContext()

  if (journey === "resume") {
    // Relay only, the setting a person turns off under "Direct connections" (apps/web/src/directSettings.ts): a
    // direct path would carry the records and the cut socket would prove nothing about resuming on the relay.
    await context.addInitScript(() => {
      localStorage.setItem("file-transfer:direct-connections", "off")
    })
  }

  const page = await context.newPage()
  page.on("request", (request) => sent.push({ page: label, kind: "url", text: request.url() }))
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      sent.push({ page: label, kind: "frame", text: Buffer.from(frame.payload).toString("latin1") })
    })
  })

  return page
}

/** Screenshot plus ARIA snapshot of a page, named by step, so the proof shows the action and the state it left. */
const capture = async (page: Page, name: string) => {
  await page.screenshot({ path: nodePath.join(evidence, `${name}.png`), fullPage: true })
  writeFileSync(nodePath.join(evidence, `${name}.aria.yml`), await page.locator("body").ariaSnapshot())
}

const status = async (page: Page) => (await page.evaluate(() => window.fileTransferTest?.status())) ?? "no test hook"

const waitForStatus = async (page: Page, wanted: readonly string[], timeout = 60_000) => {
  await page.waitForFunction((statuses) => statuses.includes(window.fileTransferTest?.status() ?? ""), wanted, { timeout }).catch(() => undefined)

  return await status(page)
}

/** What a WebSocket close carried, as Playwright's `close` takes it. */
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

const sha256 = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex")

const makeFiles = (sizes: readonly (readonly [string, number])[]) =>
  sizes.map(([name, size]) => ({ name, mimeType: "application/octet-stream", buffer: randomBytes(size) }))

/** The sender's side up to the link: choose files, seal, reveal the link. */
const offer = async (sender: Page, files: ReturnType<typeof makeFiles>) => {
  await sender.goto(`${origin}/`)
  await sender.setInputFiles("#files", files)
  step("choose files", `${await sender.locator(".file-list li").count()} files listed`, (await sender.locator(".file-list li").count()) === files.length)
  await sender.getByRole("button", { name: "Seal parcel and create link" }).click()
  const sealed = await waitForStatus(sender, ["waiting-for-recipient", "failed"])
  step("seal parcel and create link", `sender status ${sealed}`, sealed === "waiting-for-recipient")
  await sender.getByRole("button", { name: "Show link" }).click()
  const link = await sender.inputValue("#link")
  step("show link", `link with a ${new URL(link).hash.length - 1} character fragment`, new URL(link).hash.length > 32)
  await capture(sender, "01-sender-waiting")

  return link
}

/** CLAUDE.md's invariant as the browsers see it: no URL and no frame they send carries the secret or a file name. */
const checkNothingLeaks = (link: string, files: ReturnType<typeof makeFiles>) => {
  const secret = new URL(link).hash.slice(1)
  const needles = [secret, ...files.map((file) => file.name)]
  const leaks = sent.filter((item) => needles.some((needle) => item.text.includes(needle)))
  writeFileSync(
    nodePath.join(evidence, "sent.json"),
    `${JSON.stringify(
      sent.map((item) => ({ ...item, text: item.text.slice(0, 200) })),
      undefined,
      1,
    )}\n`,
  )
  step("check what the browsers sent", `${sent.length} URLs and frames, ${leaks.length} carrying the secret or a file name`, leaks.length === 0)
}

const receiveAll = async (sender: Page, recipient: Page, files: ReturnType<typeof makeFiles>, during?: () => Promise<void>) => {
  await recipient.getByRole("button", { name: /^Accept/u }).click()

  if (during !== undefined) {
    await during()
  }

  const recipientEnd = await waitForStatus(recipient, ["complete", "failed"], 120_000)
  const senderEnd = await waitForStatus(sender, ["complete", "failed"], 120_000)
  await capture(recipient, "03-recipient-complete")
  await capture(sender, "04-sender-complete")
  step("accept and receive", `recipient ${recipientEnd}, sender ${senderEnd}`, recipientEnd === "complete" && senderEnd === "complete")
  const hashes = await recipient.evaluate(async () => await window.fileTransferTest?.fileHashes())
  const expected = files.map((file) => sha256(file.buffer))
  step(
    "compare received files",
    `${hashes?.length ?? 0} files, SHA-256 ${JSON.stringify(hashes) === JSON.stringify(expected) ? "identical" : "different"}`,
    JSON.stringify(hashes) === JSON.stringify(expected),
  )
}

let failure: string | undefined

try {
  const sender = await openProfile("sender")
  const recipient = await openProfile("recipient")

  if (journey === "send-receive") {
    const files = makeFiles([
      ["verify-report.bin", 300_000],
      ["verify-notes.txt", 1200],
    ])

    const link = await offer(sender, files)
    await recipient.goto(link)
    const reviewing = await waitForStatus(recipient, ["reviewing", "failed"])
    await capture(recipient, "02-recipient-reviewing")
    step("open the link", `recipient status ${reviewing}`, reviewing === "reviewing")
    await receiveAll(sender, recipient, files)
    checkNothingLeaks(link, files)
  }

  if (journey === "decline") {
    const files = makeFiles([["verify-decline.bin", 10_000]])
    const link = await offer(sender, files)
    await recipient.goto(link)
    step("open the link", `recipient status ${await waitForStatus(recipient, ["reviewing", "failed"])}`, (await status(recipient)) === "reviewing")
    await recipient.getByRole("button", { name: "Decline", exact: true }).click()
    const senderEnd = await waitForStatus(sender, ["declined", "failed"])
    await capture(recipient, "02-recipient-declined")
    await capture(sender, "03-sender-declined")
    step("decline", `recipient ${await status(recipient)}, sender ${senderEnd}`, senderEnd === "declined" && (await status(recipient)) === "declined")
  }

  if (journey === "wrong-key") {
    const files = makeFiles([["verify-wrong-key.bin", 10_000]])
    const link = await offer(sender, files)
    await recipient.goto(link.replace(/#.*/u, "#AAAA"))
    const end = await waitForStatus(recipient, ["failed"])
    const reason = await recipient.evaluate(() => window.fileTransferTest?.failure())
    await capture(recipient, "02-recipient-damaged-link")
    step("open a damaged link", `recipient ${end}, reason ${reason ?? "none"}`, end === "failed" && reason === "invalid-secret")
    step("sender keeps waiting", `sender ${await status(sender)}`, (await status(sender)) === "waiting-for-recipient")
  }

  if (journey === "resume") {
    const sockets: WebSocketRoute[] = []
    await recipient.routeWebSocket(/\/api\/rooms\/.+\/socket/u, (socket) => {
      const server = socket.connectToServer()
      sockets.push(socket)
      socket.onMessage((message) => {
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
    // Large enough that the relay is still carrying records when the socket is cut.
    const files = makeFiles([["verify-resume.bin", 24 * 1024 * 1024]])
    const link = await offer(sender, files)
    await recipient.goto(link)
    step("open the link", `recipient status ${await waitForStatus(recipient, ["reviewing", "failed"])}`, (await status(recipient)) === "reviewing")
    await receiveAll(sender, recipient, files, async () => {
      await recipient.waitForFunction(() => {
        const progress = window.fileTransferTest?.progress()

        return progress !== undefined && progress.total > 0 && progress.done / progress.total >= 0.3
      })
      await sockets.at(-1)?.close({ code: 1012, reason: "verification cut" })
      step("cut the recipient's socket at 30%", `socket ${sockets.length} closed with 1012`, sockets.length > 0)
    })
    step("rejoin on a new socket", `${sockets.length} sockets opened`, sockets.length >= 2)
    const path = await recipient.evaluate(() => window.fileTransferTest?.wentDirect())
    step("records travelled the relay only", `went direct: ${String(path)}`, path === false)
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
} finally {
  writeFileSync(nodePath.join(evidence, "result.json"), `${JSON.stringify({ journey, origin, browser: browserName, steps, failure }, undefined, 2)}\n`)
  await browser.close()
}

console.log(failure === undefined ? `PASS ${journey}, evidence in ${evidence}` : `FAIL ${journey}: ${failure}; evidence in ${evidence}`)

process.exit(failure === undefined ? 0 : 1)
