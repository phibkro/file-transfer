/**
 * Calls from the Worker into Durable Objects, which can throw instead of answering: a transient platform error, a
 * code update resetting the object, or an overloaded object. Cloudflare marks these with `retryable` and `overloaded`
 * (https://developers.cloudflare.com/durable-objects/best-practices/error-handling/): retry with a new stub when
 * `retryable` is true, and never when `overloaded` is true. Spike 0003 saw one such throw in 76 room creations on a
 * Preview, which reached the client as Cloudflare's HTML error page (docs/spikes/0003-relay-load.md).
 */

/** Whether a thrown Durable Object error may be retried with a new stub. */
export const isRetryable = (cause: unknown): boolean => {
  if (!(cause instanceof Error)) {
    return false
  }

  const retryable = "retryable" in cause ? cause.retryable : undefined
  const overloaded = "overloaded" in cause ? cause.overloaded : undefined

  return retryable === true && overloaded !== true
}

/** The outcome of a Durable Object call: its value, or that it could not be reached even after a retry. */
export type Reached<Value> = { readonly reached: true; readonly value: Value } | { readonly reached: false }

/**
 * Runs `call` (which must make a new stub each time) and runs it once more when it throws a retryable error. Only for
 * calls that are safe to repeat. Returns plain data, so callers answer with `unavailable()` instead of throwing.
 */
export const withOneRetry = async <Value>(call: () => Promise<Value>): Promise<Reached<Value>> => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return { reached: true, value: await call() }
    } catch (error) {
      if (!isRetryable(error)) {
        return { reached: false }
      }
    }
  }

  return { reached: false }
}

/** The answer when a Durable Object could not be reached: JSON the client can act on, never the platform's HTML. */
export const unavailable = (): Response =>
  Response.json({ error: "temporarily unavailable" }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "1" } })
