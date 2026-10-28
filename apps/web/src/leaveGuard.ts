// oxlint-effect-plugin ignore-file:
// reason: browser glue over the beforeunload event; moves into libraries/client with the rest of the MVP orchestration (docs/plan.md)
/**
 * Asks before the page is closed or reloaded when that would lose something: a transfer in progress, a sender's link
 * still waiting for its recipient (the link stops working when the sender leaves), or received files not yet saved
 * (they are deleted on the next visit, storage.ts). Browsers show their own wording; the page cannot set it.
 */
import { currentStatus, onReport } from "./report.ts"
import type { Status } from "./report.ts"

// Reviewing an offer or connecting loses nothing: the link can simply be opened again.
const statusesToKeep = new Set<Status>(["labelling", "creating-room", "waiting-for-recipient", "offering", "reconnecting", "transferring"])

let unsavedFiles = false
let update = () => undefined

/** The recipient says whether it holds received files the person has not saved or removed. */
export const setUnsavedFiles = (unsaved: boolean) => {
  unsavedFiles = unsaved
  update()
}

const shouldAsk = (): boolean => statusesToKeep.has(currentStatus()) || unsavedFiles

const onBeforeUnload = (event: BeforeUnloadEvent) => {
  if (shouldAsk()) {
    event.preventDefault()
  }
}

export const installLeaveGuard = () => {
  // Listening only while it matters keeps the page eligible for the back-forward cache otherwise.
  update = () => {
    if (shouldAsk()) {
      window.addEventListener("beforeunload", onBeforeUnload)
    } else {
      window.removeEventListener("beforeunload", onBeforeUnload)
    }
  }

  onReport(update)
}
