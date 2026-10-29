/**
 * Request bodies Playwright does not report. `request.postDataBuffer()` returns null for Blob and File bodies in
 * Chromium and WebKit (found in the round 4 review of #27), so a leak check built on it alone misses them there. This
 * init script wraps the page's ways of sending a body (`fetch`, `navigator.sendBeacon`, `XMLHttpRequest.send`) and
 * hands the bytes of every Blob, File, FormData (as its whole multipart body, field and file names included) and
 * Request body to Node through an exposed binding. Patches go on the window and on prototypes, which WebKit keeps (a
 * patch on the `navigator` instance is lost after a garbage collection, found in the review of #23).
 *
 * Bodies are read in overlapping slices with a pause between them, so a large upload neither blocks the page nor runs
 * out of memory, and a needle cannot hide across a slice boundary (round 1 review of #30).
 *
 * Not covered, because an init script does not run there: a body sent from a dedicated or shared worker, or from an
 * `about:blank` frame the page has just created. A body sent as a ReadableStream is not read either.
 */
import type { BrowserContext } from "playwright"

declare global {
  interface Window {
    /** Exposed by `recordBlobBodies`: takes one slice of a body as base64. */
    fileTransferRecordBody?: (encoded: string) => Promise<void>
  }
}

/** Calls `record` with the bytes of every Blob, File, FormData and Request body any page of `context` sends, in slices. */
export const recordBlobBodies = async (context: BrowserContext, record: (bytes: Buffer) => void): Promise<void> => {
  await context.exposeBinding("fileTransferRecordBody", (_source, encoded: string) => {
    record(Buffer.from(encoded, "base64"))
  })

  await context.addInitScript(() => {
    /** One slice of a body: large enough to be quick, small enough that encoding it never strains the page. */
    const sliceLength = 1024 * 1024
    /** Slices overlap by this much, more than any needle the checks look for, so none is split between two slices. */
    const overlap = 1024
    /** Bytes go to btoa as a binary string, built in chunks under the argument-count limit of fromCodePoint. */
    const chunkLength = 0x80_00

    const encode = (bytes: Uint8Array) => {
      let binary = ""

      for (let start = 0; start < bytes.length; start += chunkLength) {
        binary += String.fromCodePoint(...bytes.subarray(start, start + chunkLength))
      }

      return btoa(binary)
    }

    const report = async (blob: Blob) => {
      for (let start = 0; start === 0 || start < blob.size; start += sliceLength - overlap) {
        const slice = new Uint8Array(await blob.slice(start, start + sliceLength).arrayBuffer())
        await window.fileTransferRecordBody?.(encode(slice))

        if (start + sliceLength >= blob.size) {
          break
        }
      }
    }

    const capture = async (body: BodyInit | Document | null | undefined) => {
      if (body instanceof Blob) {
        await report(body)
      } else if (body instanceof FormData) {
        // The multipart body as the browser builds it, so field names and file names are read too.
        await report(await new Response(body).blob())
      }
    }

    const fetchNatively = globalThis.fetch.bind(globalThis)
    // SAFETY: a page's fetch is the plain function this wraps; the `preconnect` member the type asks for is Bun's.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      void capture(init?.body)

      if (input instanceof Request && input.body !== null) {
        void input
          .clone()
          .blob()
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
