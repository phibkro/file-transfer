// oxlint-effect-plugin ignore-file:
// reason: browser glue over the DOM and the storage adapter; moves into apps/web's view layer with the rest of the MVP orchestration (docs/plan.md)
/**
 * "Storage in this browser", on every page: how much this site keeps here and a way to clear it. Received files are
 * decrypted, so a person should be able to see and remove them without digging through browser settings. Clearing
 * deletes every transfer no open page is using, and this page's own received files once the person confirms; a
 * transfer still running (here or in another tab) is left alone.
 */
import { currentStatus, onReport } from "./report.ts"
import type { Status } from "./report.ts"
import { storageUse, sweepStaleTransfers } from "./storage.ts"
import type { StorageUse } from "./storage.ts"
import { element, formatSize } from "./view.ts"

let removeHere: (() => Promise<void>) | undefined
let refresh = () => undefined

/** The recipient offers its received files for clearing once they are complete, and withdraws them once removed. */
export const offerRemoval = (remove: (() => Promise<void>) | undefined) => {
  removeHere = remove
  refresh()
}

/** Files that Clear can delete: everything stored except transfers that another page, or a running one, holds. */
const clearable = (use: StorageUse): boolean => use.stale > 0 || removeHere !== undefined

const describe = (use: StorageUse): string => {
  const received = use.receivedBytes === 0 ? "No received files are stored here." : `Received files stored here: ${formatSize(use.receivedBytes)}.`

  const site =
    use.usage === undefined || use.quota === undefined
      ? ""
      : ` This site uses ${formatSize(use.usage)} of this browser's storage, with ${formatSize(Math.max(0, use.quota - use.usage))} more available.`

  const others = use.inUse - (removeHere === undefined ? 0 : 1)
  const kept = others > 0 ? " Files of a transfer still running here or in another tab are kept until it ends." : ""

  return `${received}${site}${kept}`
}

export const storagePanel = (): HTMLElement => {
  const heading = element("summary", {}, ["Storage in this browser"])
  const text = element("p", { class: "storage-text", role: "status" })
  const clear = element("button", { type: "button" }, ["Clear stored files"])
  const confirm = element("button", { type: "button", class: "primary" }, ["Delete"])
  const cancel = element("button", { type: "button" }, ["Cancel"])
  const question = element("p", { class: "storage-question" })
  const confirmation = element("div", { class: "storage-confirmation", hidden: "" }, [question, confirm, cancel])

  const panel = element("details", { class: "storage-panel" }, [
    heading,
    text,
    element("div", { class: "storage-actions" }, [clear]),
    confirmation,
    element("p", { class: "storage-note" }, ["Files you saved to your device are not affected."]),
  ])

  const show = async () => {
    const use = await storageUse()
    heading.textContent = use.receivedBytes === 0 ? "Storage in this browser" : `Storage in this browser: ${formatSize(use.receivedBytes)}`
    text.textContent = describe(use)
    clear.disabled = !clearable(use)

    return use
  }

  refresh = () => {
    void show()
  }

  // Another tab may have stored or cleared files since the last status change: measure again whenever it opens.
  panel.addEventListener("toggle", () => {
    if (panel.open) {
      refresh()
    }
  })

  clear.addEventListener("click", () => {
    void (async () => {
      const use = await show()
      question.textContent = `Delete ${formatSize(use.receivedBytes)} of received files from this browser?`
      confirmation.hidden = false
      clear.hidden = true
      confirm.focus()
    })()
  })

  const closeConfirmation = () => {
    confirmation.hidden = true
    clear.hidden = false
  }

  cancel.addEventListener("click", closeConfirmation)
  confirm.addEventListener("click", () => {
    void (async () => {
      confirm.disabled = true
      await removeHere?.()
      await sweepStaleTransfers()
      closeConfirmation()
      confirm.disabled = false
      await show()
    })()
  })

  // Storage changes when a transfer starts, completes or fails; progress updates in between are skipped.
  let lastStatus: Status | undefined
  onReport(() => {
    if (currentStatus() !== lastStatus) {
      lastStatus = currentStatus()
      refresh()
    }
  })
  refresh()

  return panel
}
