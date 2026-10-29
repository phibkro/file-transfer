/**
 * The page's address, read in one place. The URL fragment carries the link secret (docs/parcel.md, "Secrets and
 * link"), which must never reach a log, a request or a report by accident. Only `linkFragment` returns it, and a lint
 * rule (vite.config.ts) rejects `location` and the other properties that expose the page's URL in every other module
 * (a read through Reflect, or a computed property named by a variable, still gets past it).
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
