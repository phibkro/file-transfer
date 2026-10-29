/**
 * Entry point: `/` sends, `/r/<room>` receives. The link secret lives in the URL fragment, which browsers never
 * send to a server; this app reads it once and never puts it in a request (apps/web/README.md).
 */
import { startRecipient } from "./recipient.ts"
import { installLeaveGuard } from "./leaveGuard.ts"
import { installTestHook } from "./report.ts"
import { startSender } from "./sender.ts"
import { sweepStaleTransfers } from "./storage.ts"
import { installSiteChrome } from "./site.ts"
import { storagePanel } from "./storagePanel.ts"
import { showSummaryOnCompletion } from "./summary.ts"

const root = document.querySelector<HTMLElement>("#app")

if (root !== null) {
  installTestHook()
  installLeaveGuard()
  // Received files from tabs that are gone are deleted before anything else touches storage (storage.ts).
  await sweepStaleTransfers()
  const storage = storagePanel()
  root.after(storage)
  installSiteChrome(root, storage)
  const recipientPath = /^\/r\/(?<roomIdentifier>[A-Za-z0-9_-]{22})\/?$/u.exec(location.pathname)
  const roomIdentifier = recipientPath?.groups?.roomIdentifier

  if (roomIdentifier === undefined) {
    startSender(root)
    showSummaryOnCompletion(root, "sender")
  } else {
    startRecipient(root, roomIdentifier)
    showSummaryOnCompletion(root, "recipient")
  }
}
