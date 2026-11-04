/**
 * Drives one user journey against a running instance the way two people would, in two isolated browser profiles, and
 * writes the evidence (.claude/skills/verify-file-transfer, features/): a screenshot and an ARIA snapshot of each page
 * after each step, every request URL, request body and socket frame the browsers sent (not a body sent from a worker, a
 * just-created about:blank frame or as a stream), and `result.json` with each step's action and observed outcome. Exits non-zero when the journey fails; the evidence stays either way.
 *
 *   bun apps/web/scripts/verify/drive.ts <journey> <origin> <evidence directory> [chromium | firefox | webkit]
 *
 * Journeys: send-receive, decline, wrong-key, resume, library.
 */
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import nodePath from "node:path"
import { chromium, firefox, webkit } from "playwright"
import type { Browser, LaunchOptions, Page, WebSocketRoute } from "playwright"
import { recordBlobBodies } from "../requestBodies.ts"
import type { BodyRecorder } from "../requestBodies.ts"

const journeys = ["send-receive", "decline", "wrong-key", "resume", "library"] as const

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

/** Text frames (control messages) each page received, with the time, for checks on what the room told whom. */
const controlReceived: { readonly page: string; readonly at: number; readonly text: string }[] = []
const sent: { readonly page: string; readonly kind: "url" | "body" | "frame"; readonly text: string }[] = []

/** One per browser profile: waits for the request bodies its pages are still reading (../requestBodies.ts). */
const bodyRecorders: BodyRecorder[] = []

const step = (action: string, observed: string, ok: boolean) => {
  steps.push({ action, observed, ok })
  console.log(`${ok ? "ok" : "NOT OK"} ${action}: ${observed}`)

  if (!ok) {
    throw new Error(`${action}: ${observed}`)
  }
}

const browserTypes = { chromium, firefox, webkit } as const
const isBrowserName = (value: string): value is keyof typeof browserTypes => Object.hasOwn(browserTypes, value)

if (!isBrowserName(browserName)) {
  console.error(`unknown browser ${browserName}; use chromium, firefox or webkit`)
  process.exit(2)
}

const browserType = browserTypes[browserName]
const launchOptions: LaunchOptions = process.env.E2E_BROWSER_EXECUTABLE_PATH === undefined ? {} : { executablePath: process.env.E2E_BROWSER_EXECUTABLE_PATH }
const browser: Browser = await browserType.launch(launchOptions)

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

  // Blob and File bodies, which Playwright's request events do not carry in Chromium and WebKit (../requestBodies.ts).
  const bodyRecorder = await recordBlobBodies(context, (bytes) => {
    sent.push({ page: label, kind: "body", text: bytes.toString("latin1") })
  })

  bodyRecorders.push(bodyRecorder)
  const page = await context.newPage()
  page.on("request", (request) => {
    sent.push({ page: label, kind: "url", text: request.url() })
    const body = request.postData()

    if (body !== null) {
      sent.push({ page: label, kind: "body", text: body })
    }
  })
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      sent.push({ page: label, kind: "frame", text: Buffer.from(frame.payload).toString("latin1") })
    })
    socket.on("framereceived", (frame) => {
      // Control messages travel as text frames; parcel units are binary and carry nothing these checks read.
      if (!Buffer.isBuffer(frame.payload)) {
        controlReceived.push({ page: label, at: Date.now(), text: frame.payload })
      }
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

/** Wait for the disclosure to expose the actual fragment, not its masked value. */
const revealLink = async (page: Page) => {
  await page.getByRole("button", { name: "Show link" }).click()
  await page.waitForFunction(() => /#[A-Za-z0-9_-]{33,}$/u.test(document.querySelector<HTMLInputElement>("#link")?.value ?? ""))
  const link = await page.inputValue("#link")
  privateLinks.push(link)

  return link
}

const hideLink = async (page: Page) => {
  await page.getByRole("button", { name: "Hide link" }).click()
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLInputElement>("#link")

    return input === null || input.offsetParent === null || !/#[A-Za-z0-9_-]{33,}$/u.test(input.value)
  })
}

/** The sender's side up to the link: choose files, seal, reveal the link. */
const offer = async (sender: Page, files: ReturnType<typeof makeFiles>) => {
  await sender.goto(`${origin}/`)
  await sender.setInputFiles("#files", files)
  step("choose files", `${await sender.locator(".file-list li").count()} files listed`, (await sender.locator(".file-list li").count()) === files.length)
  await sender.getByRole("button", { name: "Seal parcel and create link" }).click()
  const sealed = await waitForStatus(sender, ["waiting-for-recipient", "failed"])
  step("seal parcel and create link", `sender status ${sealed}`, sealed === "waiting-for-recipient")
  const link = await revealLink(sender)
  step("show link", `link with a ${new URL(link).hash.length - 1} character fragment`, new URL(link).hash.length > 32)
  await hideLink(sender)
  await capture(sender, "01-sender-waiting")

  return link
}

/**
 * CLAUDE.md's invariant as the browsers see it: no URL, request body or frame they send carries the secret or a file
 * name. Bodies sent from a worker, a just-created about:blank frame or as a ReadableStream are not seen (requestBodies.ts).
 */
const checkNothingLeaks = async (links: readonly string[], files: ReturnType<typeof makeFiles>) => {
  const secrets = links.map((link) => new URL(link).hash.slice(1))
  const needles = [...secrets, ...files.map((file) => file.name)]
  // A body is read at about 10 MB/s; wait for every read in flight before looking.
  const unreadPerProfile = await Promise.all(bodyRecorders.map(async (recorder) => await recorder.settled()))
  const unread = unreadPerProfile.reduce((total, count) => total + count, 0)

  const leaks = [
    ...sent.filter((item) => needles.some((needle) => item.text.includes(needle))),
    ...(unread > 0 ? [{ page: "both", kind: "body" as const, text: `${unread} request bodies were still being read` }] : []),
  ]

  const redact = (value: string) => {
    let result = value

    for (const needle of needles) {
      result = result.replaceAll(needle, "[redacted]")
    }

    return result.slice(0, 200)
  }

  writeFileSync(
    nodePath.join(evidence, "sent.json"),
    `${JSON.stringify(
      sent.map((item) => ({ ...item, text: redact(item.text) })),
      undefined,
      1,
    )}\n`,
  )
  step("check what the browsers sent", `${sent.length} URLs, request bodies and frames, ${leaks.length} carrying the secret or a file name`, leaks.length === 0)
}

const receiveAll = async (sender: Page, recipient: Page, files: ReturnType<typeof makeFiles>, during?: () => Promise<void>, prefix = "") => {
  await recipient.getByRole("button", { name: /^Accept/u }).click()

  if (during !== undefined) {
    await during()
  }

  const recipientEnd = await waitForStatus(recipient, ["complete", "failed"], 120_000)
  const senderEnd = await waitForStatus(sender, ["complete", "failed"], 120_000)
  await capture(recipient, `${prefix}03-recipient-complete`)
  await capture(sender, `${prefix}04-sender-complete`)
  step("accept and receive", `recipient ${recipientEnd}, sender ${senderEnd}`, recipientEnd === "complete" && senderEnd === "complete")
  const hashes = await recipient.evaluate(async () => await window.fileTransferTest?.fileHashes())
  const expected = files.map((file) => sha256(file.buffer))
  step(
    "compare received files",
    `${hashes?.length ?? 0} files, SHA-256 ${JSON.stringify(hashes) === JSON.stringify(expected) ? "identical" : "different"}`,
    JSON.stringify(hashes) === JSON.stringify(expected),
  )
}

/** Inspect only persisted metadata; never seed the catalog or return its contents to evidence. */
const catalog = async (page: Page) =>
  await page.evaluate(
    async () =>
      await new Promise<{
        files: { fingerprint: string; size: number; lastModified: number }[]
        collections: { fileIdentifiers: number[] }[]
        enabled: boolean
        blobs: number
      }>((resolve, reject) => {
        const open = indexedDB.open("local-library")
        open.addEventListener("error", () => {
          reject(new Error("Cannot open catalog"))
        })
        open.addEventListener("success", () => {
          const database = open.result
          const transaction = database.transaction(["files", "collections", "settings"], "readonly")
          const files = transaction.objectStore("files").getAll()
          const collections = transaction.objectStore("collections").getAll()
          const consent = transaction.objectStore("settings").get("consent")
          transaction.addEventListener("error", () => {
            reject(new Error("Cannot read catalog"))
          })
          transaction.addEventListener("complete", () => {
            // SAFETY: The Library owns these IndexedDB stores and writes flat metadata records.
            const storedFiles = files.result as { fingerprint: string; size: number; lastModified: number; [key: string]: string | number | Blob }[]
            // SAFETY: Collections and consent have the shapes written by the Library.
            const storedCollections = collections.result as { fileIdentifiers: number[] }[]
            // SAFETY: Consent is absent before opt-in or has an enabled field.
            const setting = consent.result as { enabled: boolean } | undefined
            const blobs = storedFiles.flatMap((entry) => Object.values(entry)).filter((value) => value instanceof Blob).length
            const result = { files: storedFiles, collections: storedCollections, enabled: setting?.enabled === true, blobs }
            database.close()
            resolve(result)
          })
        })
      }),
  )

/** Playwright supplies the bytes; the DOM file-input boundary supplies a deterministic timestamp. */
const chooseLibraryFile = async (page: Page, file: ReturnType<typeof makeFiles>[number]) => {
  const input = page.locator("label.drop-zone input[type=file]")
  await input.evaluate(
    (element, payload) => {
      if (!(element instanceof HTMLInputElement)) {
        throw new Error("Library input is not a file input")
      }

      const selected = new File([Uint8Array.from(payload.bytes)], payload.name, { type: payload.type, lastModified: 1_700_000_000_000 })
      const transfer = new DataTransfer()
      transfer.items.add(selected)
      element.files = transfer.files
      element.dispatchEvent(new Event("change", { bubbles: true }))
    },
    { name: file.name, type: file.mimeType, bytes: Array.from(file.buffer) },
  )
}

let failure: string | undefined
const pages: { readonly side: string; readonly page: Page }[] = []
const privateLinks: string[] = []

// What each side reported when the journey failed: its status, failure reason and the exception behind it.
const failedSides: { readonly side: string; readonly status: string; readonly reason: string | null; readonly detail: string | null }[] = []

try {
  const sender = await openProfile("sender")
  const recipient = await openProfile("recipient")
  pages.push({ side: "sender", page: sender }, { side: "recipient", page: recipient })

  if (journey === "library") {
    const [original, control] = makeFiles([
      ["verify-library-private.bin", 4096],
      ["verify-library-control.bin", 2048],
    ])

    if (original === undefined || control === undefined) {
      throw new Error("Missing verification files")
    }

    const modified = { ...original, buffer: Buffer.from(original.buffer) }
    modified.buffer[0] = (modified.buffer[0] ?? 0) ^ 255
    const links = privateLinks
    await sender.goto(`${origin}/library`)
    await sender.getByText("Remembering is off by default", { exact: false }).waitFor()
    const initially = await catalog(sender)
    step(
      "default Library before opt-in",
      "My files is available, remembering is off",
      !initially.enabled &&
        initially.files.length === 0 &&
        initially.collections.length === 0 &&
        (await sender.getByRole("heading", { name: "My files" }).isVisible()),
    )
    await capture(sender, "01-library-default")
    await sender.getByRole("switch", { name: "Remember files on this device" }).click()
    await sender.getByText("Remembering is enabled", { exact: false }).waitFor()
    await sender.getByLabel("New collection name").fill("Verification collection")
    await sender.getByRole("button", { name: "Create empty collection" }).click()
    await sender.getByRole("option", { name: "Verification collection (0)" }).waitFor({ state: "attached" })
    const empty = await catalog(sender)
    step(
      "create an empty collection",
      "one empty collection, no files",
      empty.enabled && empty.files.length === 0 && empty.collections.length === 1 && empty.collections[0]?.fileIdentifiers.length === 0,
    )
    await capture(sender, "02-library-empty")
    await chooseLibraryFile(sender, original)
    await sender.getByRole("checkbox", { name: original.name }).waitFor()
    await chooseLibraryFile(sender, control)
    await sender.getByRole("checkbox", { name: control.name }).waitFor()
    const indexed = await catalog(sender)
    step("index originals", "two metadata entries, no stored file bytes", indexed.files.length === 2 && indexed.blobs === 0)
    await sender.getByRole("checkbox", { name: original.name }).click()
    await sender.getByRole("button", { name: "Add selected to Verification collection" }).click()
    await sender.getByRole("option", { name: "Verification collection (1)" }).waitFor({ state: "attached" })
    await sender.getByLabel("Collection", { exact: true }).selectOption({ label: "Verification collection (1)" })
    await sender.getByRole("heading", { name: "Verification collection" }).waitFor()
    const withMember = await catalog(sender)
    step("add a collection member", "collection has the indexed file", withMember.collections[0]?.fileIdentifiers.length === 1)
    await capture(sender, "03-library-member")

    const share = async (file: typeof original, prefix: string) => {
      await sender.getByRole("button", { name: "Approve and share current versions" }).click()
      await sender.getByRole("heading", { name: "Quick Share" }).waitFor()
      const state = await waitForStatus(sender, ["waiting-for-recipient", "failed"])
      step("seal collection share", `sender ${state}`, state === "waiting-for-recipient")
      const link = await revealLink(sender)
      await hideLink(sender)
      await recipient.goto(link)
      const stateRecipient = await waitForStatus(recipient, ["reviewing", "failed"])
      step("open collection share", `recipient ${stateRecipient}`, stateRecipient === "reviewing")
      await capture(recipient, `${prefix}02-recipient-reviewing`)
      await receiveAll(sender, recipient, [file], undefined, prefix)
    }

    await sender.getByRole("button", { name: "Review collection before sharing" }).click()
    await sender.getByText("Unchanged since indexing or last approval").waitFor()
    await capture(sender, "04-library-review-original")
    await share(original, "original-")
    const baseline = await catalog(sender)
    await sender.goto(`${origin}/library`)
    await sender.getByRole("option", { name: "Verification collection (1)" }).waitFor({ state: "attached" })
    await sender.getByLabel("Collection", { exact: true }).selectOption({ label: "Verification collection (1)" })
    const roomRequests = sent.filter((entry) => entry.page === "sender" && entry.kind === "url" && entry.text.includes("/api/rooms")).length
    await sender.getByRole("button", { name: "Review collection before sharing" }).click()
    await sender.getByText("Could not complete this local operation", { exact: false }).waitFor()
    const roomRequestsAfter = sent.filter((entry) => entry.page === "sender" && entry.kind === "url" && entry.text.includes("/api/rooms")).length
    step(
      "block missing original",
      "review failed before creating a room",
      roomRequestsAfter === roomRequests && (await sender.getByRole("heading", { name: "Library" }).isVisible()),
    )
    await sender.getByRole("button", { name: "Reconnect original" }).click()
    await sender.getByText("Choose the original to reconnect").waitFor()
    await chooseLibraryFile(sender, modified)
    await sender.getByRole("button", { name: "Confirm replacement reference" }).click()
    await sender.getByText("Library updated on this device only.").waitFor()
    await sender.getByLabel("Collection", { exact: true }).selectOption({ label: "Verification collection (1)" })
    await sender.getByRole("heading", { name: "Verification collection" }).waitFor()
    await sender.getByRole("button", { name: "Review collection before sharing" }).click()
    await sender.getByText("Changed since indexing or last approval").waitFor()
    const beforeApproval = await catalog(sender)
    step(
      "reconnect changed bytes",
      "same size and modification time, old approval preserved",
      baseline.files[0] !== undefined &&
        beforeApproval.files[0] !== undefined &&
        baseline.files[0].fingerprint === beforeApproval.files[0].fingerprint &&
        baseline.files[0].size === beforeApproval.files[0].size &&
        baseline.files[0].lastModified === beforeApproval.files[0].lastModified,
    )
    await capture(sender, "05-library-review-changed")
    await sender.getByRole("button", { name: "Cancel", exact: true }).click()
    await sender.getByRole("button", { name: "Review collection before sharing" }).click()
    await sender.getByText("Changed since indexing or last approval").waitFor()
    const afterCancel = await catalog(sender)
    step(
      "require explicit approval",
      "cancelling review preserves the previous fingerprint",
      afterCancel.files[0]?.fingerprint === baseline.files[0]?.fingerprint,
    )
    await share(modified, "modified-")
    const approved = await catalog(sender)
    step("approve changed version", "the approved fingerprint changed", approved.files[0]?.fingerprint !== baseline.files[0]?.fingerprint)
    await sender.goto(`${origin}/library`)
    await sender.getByText("Remembering is enabled", { exact: false }).waitFor()
    await sender.getByRole("switch", { name: "Remember files on this device" }).click()
    await sender.getByRole("button", { name: "Forget", exact: true }).click()
    await sender.getByText("Remembering is off by default", { exact: false }).waitFor()
    const forgotten = await catalog(sender)
    step(
      "opt out",
      "catalog empty, My files remains",
      !forgotten.enabled &&
        forgotten.files.length === 0 &&
        forgotten.collections.length === 0 &&
        forgotten.blobs === 0 &&
        (await sender.getByRole("heading", { name: "My files" }).isVisible()),
    )
    await capture(sender, "06-library-opted-out")
    await checkNothingLeaks(links, [original, modified, control])
  }

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
    await checkNothingLeaks([link], files)
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
    // Both ends of each routed socket, so a cut can close both, as a server restart does.
    // Both ends of each routed socket, so the cut can close both.
    const sockets: { readonly page: WebSocketRoute; readonly server: WebSocketRoute }[] = []
    await recipient.routeWebSocket(/\/api\/rooms\/.+\/socket/u, (socket) => {
      const server = socket.connectToServer()
      sockets.push({ page: socket, server })
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
    let cutAt = 0
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
      const cut = sockets.at(-1)
      cutAt = Date.now()
      // The room's end is a socket the browser opened (Playwright's connectToServer), and a browser closes a socket only
      // with 1000 or 3000 to 4999: a 1012 there is refused and the room never hears the close. So the page's end gets
      // 1012, as a server restart would send, and the room's end gets 1000.
      await cut?.page.close({ code: 1012, reason: "verification cut" })
      await cut?.server.close({ code: 1000, reason: "verification cut" })
      step("cut the recipient's socket at 30%, both ends", `socket ${sockets.length} closed, 1012 to the page and 1000 to the room`, cut !== undefined)
    })
    step("rejoin on a new socket", `${sockets.length} sockets opened`, sockets.length >= 2)
    // A room that heard the close tells the sender `peer left`; one that did not hears of it only when the new socket
    // replaces the old, which sends the sender `peer joined` and no `peer left` (docs/protocol.md).
    const heardLeave = controlReceived.some((frame) => frame.page === "sender" && frame.at >= cutAt && frame.text.includes('"event":"left"'))
    step("the room heard the cut and told the sender", heardLeave ? "the sender got peer left" : "the sender got no peer left", heardLeave)
    const path = await recipient.evaluate(() => window.fileTransferTest?.wentDirect())
    step("records travelled the relay only", `went direct: ${String(path)}`, path === false)
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)

  for (const link of privateLinks) {
    failure = failure.replaceAll(link, "[private link]").replaceAll(new URL(link).hash.slice(1), "[secret]")
  }

  // Evidence of the failure itself: each page as it was, with the reason it gives.
  for (const { side, page } of pages) {
    await capture(page, `failed-${side}`).catch(() => undefined)

    const report = await page
      .evaluate(() => ({
        status: window.fileTransferTest?.status() ?? "no test hook",
        reason: window.fileTransferTest?.failure(),
        detail: window.fileTransferTest?.failureDetail(),
      }))
      .catch(() => ({ status: "page closed", reason: undefined, detail: undefined }))

    failedSides.push({ side, status: report.status, reason: report.reason ?? null, detail: report.detail ?? null })
  }
} finally {
  writeFileSync(
    nodePath.join(evidence, "result.json"),
    `${JSON.stringify({ journey, origin, browser: browserName, steps, failure, failedSides }, undefined, 2)}\n`,
  )
  await browser.close()
}

console.log(failure === undefined ? `PASS ${journey}, evidence in ${evidence}` : `FAIL ${journey}: ${failure}; evidence in ${evidence}`)

process.exit(failure === undefined ? 0 : 1)
