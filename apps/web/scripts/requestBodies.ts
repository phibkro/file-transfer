/**
 * Request bodies Playwright does not report. `request.postDataBuffer()` returns null for Blob and File bodies in
 * Chromium and WebKit (found in the round 4 review of #27), so a leak check built on it alone misses them there. This
 * init script wraps the page's ways of sending a body (`fetch`, `navigator.sendBeacon`, `XMLHttpRequest.send`) and
 * hands the bytes of every Blob, File, FormData and Request body to Node through an exposed binding. Patches go on the
 * window and on prototypes, which WebKit keeps (a patch on the `navigator` instance is lost after a garbage collection,
 * found in the review of #23). A body sent as a ReadableStream is not read.
 */
import type { BrowserContext } from "playwright"

declare global {
  interface Window {
    /** Exposed by `recordBlobBodies`: takes one body's bytes as base64. */
    fileTransferRecordBody?: (encoded: string) => Promise<void>
  }
}

/** Calls `record` with the bytes of every Blob, File, FormData and Request body any page of `context` sends. */
export const recordBlobBodies = async (context: BrowserContext, record: (bytes: Buffer) => void): Promise<void> => {
  await context.exposeBinding("fileTransferRecordBody", (_source, encoded: string) => {
    record(Buffer.from(encoded, "base64"))
  })

  await context.addInitScript(() => {
    // Bytes go to btoa as a binary string, built in chunks so a large body does not exceed the argument limit.
    const chunkLength = 0x80_00

    const report = (bytes: ArrayBuffer) => {
      const view = new Uint8Array(bytes)
      let binary = ""

      for (let start = 0; start < view.length; start += chunkLength) {
        binary += String.fromCodePoint(...view.subarray(start, start + chunkLength))
      }

      void window.fileTransferRecordBody?.(btoa(binary))
    }

    const capture = async (body: BodyInit | Document | null | undefined) => {
      if (body instanceof Blob) {
        report(await body.arrayBuffer())
      } else if (body instanceof FormData) {
        for (const [, value] of body) {
          report(value instanceof Blob ? await value.arrayBuffer() : new TextEncoder().encode(value).buffer)
        }
      }
    }

    const fetchNatively = globalThis.fetch.bind(globalThis)
    // SAFETY: a page's fetch is the plain function this wraps; the `preconnect` member the type asks for is Bun's.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      void capture(init?.body)

      if (input instanceof Request && input.body !== null) {
        void input
          .clone()
          .arrayBuffer()
          .then(report, () => undefined)
      }

      return await fetchNatively(input, init)
    }) as typeof fetch

    const beacon = Object.getOwnPropertyDescriptor(Navigator.prototype, "sendBeacon")
    // SAFETY: every browser the suites drive defines sendBeacon as a method of Navigator.prototype.
    const sendBeaconNatively = beacon?.value as (this: Navigator, url: string | URL, data?: BodyInit | null) => boolean
    Navigator.prototype.sendBeacon = function sendBeacon(this: Navigator, url: string | URL, data?: BodyInit | null) {
      void capture(data)

      return sendBeaconNatively.call(this, url, data)
    }

    const xhrSend = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "send")
    // SAFETY: every browser the suites drive defines send as a method of XMLHttpRequest.prototype.
    const sendNatively = xhrSend?.value as (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) => void
    XMLHttpRequest.prototype.send = function send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      void capture(body)
      sendNatively.call(this, body)
    }
  })
}
