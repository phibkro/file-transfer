/**
 * The page's address, read in one place. The URL fragment carries the link secret (docs/parcel.md, "Secrets and
 * link"), which must never reach a log, a request or a report by accident. Only `linkFragment` returns it, and a lint
 * rule (vite.config.ts) rejects the common reads of the page's URL in every other module. It guards against a
 * mistake, not a determined read (a form's `action` or a prototype getter still return the URL); the end-to-end leak
 * check (every request URL, request body and socket frame, except a body sent from a worker or a just-created
 * about:blank frame, or as a ReadableStream) is the evidence that nothing secret leaves the browser.
 */

/** The page's origin, for building links: `https://host[:port]`, never with a path or fragment. */
export const pageOrigin = (): string => location.origin

/** The page's host and port, for the room socket's URL. */
export const pageHost = (): string => location.host

/** Whether the page was served over HTTPS, so its sockets must be `wss:`. */
export const isSecurePage = (): boolean => location.protocol === "https:"

/** The page's path, which names the room on a recipient link. */
export const pagePath = (): string => location.pathname

/** The fragment, link secret included. The recipient reads it once, to decode the secret; nothing else may. */
export const linkFragment = (): string => location.hash
