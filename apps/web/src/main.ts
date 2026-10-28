/**
 * Entry point: `/` sends, `/r/<room>` receives. The link secret lives in the URL fragment, which browsers never
 * send to a server; this app reads it once and never puts it in a request (apps/web/README.md).
 */
import { startRecipient } from "./recipient.ts"
import { installTestHook } from "./report.ts"
import { startSender } from "./sender.ts"

const root = document.getElementById("app")
if (root !== null) {
  installTestHook()
  const recipientPath = /^\/r\/([A-Za-z0-9_-]{22})\/?$/.exec(location.pathname)
  const roomIdentifier = recipientPath?.[1]
  if (roomIdentifier !== undefined) startRecipient(root, roomIdentifier)
  else startSender(root)
}
