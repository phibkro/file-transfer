/**
 * Request bodies Playwright does not report. `request.postDataBuffer()` returns null for Blob and File bodies in
 * Chromium and WebKit (found in the round 4 review of #27), so a leak check built on it alone misses them there. This
 * init script wraps the page's ways of sending a body (`fetch`, `navigator.sendBeacon`, `XMLHttpRequest.send`) and
 * hands the bytes of every Blob, File, FormData (as its whole multipart body, field and file names included) and
 * Request body to Node through an exposed binding. Patches go on the window and on prototypes, which WebKit keeps (a
 * patch on the `navigator` instance is lost after a garbage collection, found in the review of #23).
 *
 * Bodies are read in overlapping slices with a pause between them, so a large upload neither blocks the page nor runs
 * out of memory, and a needle cannot hide across a slice boundary (round 1 review of #30). Reading takes time (about
 * 10 MB/s), so `settled` waits for every read the page started before a check looks (round 2 review of #30). A POST
 * form's submission is read too: `HTMLFormElement.submit` (which fires no event) and every `submit` event.
 *
 * Not covered, because an init script does not run there: a body sent from a dedicated or shared worker, or from an
 * `about:blank` frame the page has just created. A body sent as a ReadableStream is not read either.
 */
import type { BrowserContext } from "playwright"

declare global {
  interface Window {
    /** Exposed by `recordBlobBodies`: takes one slice of a body as base64. */
    fileTransferRecordBody?: (encoded: string) => Promise<void>
    /** Exposed by `recordBlobBodies`: a body read starts (+1) or ends (-1). */
    fileTransferBodyReads?: (change: number) => Promise<void>
  }
}

export interface BodyRecorder {
  /** Waits until every body read the pages started has finished, or `limitMilliseconds` passed; returns the reads left. */
  readonly settled: (limitMilliseconds?: number) => Promise<number>
}

/** Calls `record` with the bytes of every Blob, File, FormData and Request body any page of `context` sends, in slices. */
export const recordBlobBodies = async (context: BrowserContext, record: (bytes: Buffer) => void): Promise<BodyRecorder> => {
  let reading = 0
  await context.exposeBinding("fileTransferRecordBody", (_source, encoded: string) => {
    record(Buffer.from(encoded, "base64"))
  })
  await context.exposeBinding("fileTransferBodyReads", (_source, change: number) => {
    reading += change
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

    /** Reads one body, telling Node when the read starts and ends; a read that fails (the page went away) ends quietly. */
    const read = async (blob: () => Promise<Blob>) => {
      await window.fileTransferBodyReads?.(1)

      try {
        await report(await blob())
      } catch {
        // The body could not be read (a page closing mid-read, say); the read still ends below.
      } finally {
        await window.fileTransferBodyReads?.(-1)
      }
    }

    const capture = async (body: BodyInit | Document | null | undefined) => {
      if (body instanceof Blob) {
        await read(async () => body)
      } else if (body instanceof FormData) {
        // The multipart body as the browser builds it, so field names and file names are read too.
        await read(async () => await new Response(body).blob())
      }
    }

    /** A form's submission, when it carries a body: a GET form's fields go into the URL, which the checks read already. */
    const captureForm = (form: HTMLFormElement) => {
      if (form.method.toLowerCase() === "post") {
        void capture(new FormData(form))
      }
    }

    // `requestSubmit` and a submit button fire this event; `submit()` does not, so it is wrapped below.
    window.addEventListener(
      "submit",
      (event) => {
        if (event.target instanceof HTMLFormElement) {
          captureForm(event.target)
        }
      },
      true,
    )

    const formSubmit = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "submit")
    // SAFETY: every browser the suites drive defines submit as a method of HTMLFormElement.prototype.
    const submitNatively = formSubmit?.value as (this: HTMLFormElement) => void
    HTMLFormElement.prototype.submit = function submit(this: HTMLFormElement) {
      captureForm(this)
      submitNatively.call(this)
    }

    const fetchNatively = globalThis.fetch.bind(globalThis)
    // SAFETY: a page's fetch is the plain function this wraps; the `preconnect` member the type asks for is Bun's.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      void capture(init?.body)

      if (input instanceof Request && input.body !== null) {
        const copy = input.clone()
        void read(async () => await copy.blob())
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

  return {
    settled: async (limitMilliseconds = 120_000) => {
      const deadline = Date.now() + limitMilliseconds

      while (reading > 0 && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
      }

      return reading
    },
  }
}
