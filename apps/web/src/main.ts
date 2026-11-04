/**
 * Entry point: `/` sends, `/r/<room>` receives. The link secret lives in the URL fragment, which browsers never
 * send to a server; this app reads it once and never puts it in a request (apps/web/README.md).
 */
import { Effect } from "effect"
import { startRecipient } from "./recipient.ts"
import { installTestHook } from "./report.ts"
import { startSender } from "./sender.ts"
import { startLibrary } from "./libraryView.ts"

const root = document.getElementById("app")
if (root !== null) {
  installTestHook()
  const recipientPath = /^\/r\/([A-Za-z0-9_-]{22})\/?$/.exec(location.pathname)
  const roomIdentifier = recipientPath?.[1]
  if (roomIdentifier !== undefined) startRecipient(root, roomIdentifier)
  else {
    const navigation = document.createElement("nav")
    navigation.setAttribute("aria-label", "Main navigation")
    const quickShare = document.createElement("a")
    quickShare.href = "/"
    quickShare.textContent = "Quick Share"
    const library = document.createElement("a")
    library.href = "/library"
    library.textContent = "Library"
    navigation.append(quickShare, library)
    root.before(navigation)
    if (location.pathname === "/library")
      startLibrary(
        root,
        (files) => {
          startSender(root, files)
        },
        (program) => {
          void Effect.runPromise(program)
        },
      )
    else startSender(root)
  }
}
