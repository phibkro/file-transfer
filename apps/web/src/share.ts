// oxlint-effect-plugin ignore-file:
// reason: browser glue over clipboard and share-sheet Promises; moves into libraries/client with the rest of the MVP orchestration (docs/plan.md)
/**
 * The sender's share panel: Copy, Share (the device's share sheet, so the link can go to any messaging app the person
 * uses), and the link and its QR code, both hidden until asked for so the secret is not on screen by default. The QR
 * matrix comes from uqr (MIT, unjs/uqr) and is drawn with DOM calls, never as markup. Nothing here sends the link
 * anywhere except where the person chooses to share it.
 */
import { element } from "./view.ts"

const svgNamespace = "http://www.w3.org/2000/svg"

/**
 * The link as a QR code: one path of unit squares, with the standard four-module quiet zone. The encoder is loaded on
 * first use, so pages where nobody asks for a QR code never download it.
 */
const qrCode = async (link: string): Promise<SVGSVGElement> => {
  const { encode } = await import("uqr")
  const { data, size } = encode(link, { ecc: "M", border: 4 })
  const path = data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join("")
  const svg = document.createElementNS(svgNamespace, "svg")
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`)
  svg.setAttribute("role", "img")
  svg.setAttribute("aria-label", "QR code of the share link")
  svg.setAttribute("class", "qr-code")
  svg.setAttribute("shape-rendering", "crispEdges")
  const background = document.createElementNS(svgNamespace, "rect")
  background.setAttribute("width", String(size))
  background.setAttribute("height", String(size))
  background.setAttribute("fill", "#fff")
  const modules = document.createElementNS(svgNamespace, "path")
  modules.setAttribute("d", path)
  modules.setAttribute("fill", "#000")
  svg.append(background, modules)

  return svg
}

/** The link with its secret fragment masked: the room identifier is not secret, the fragment is. */
const maskedLink = (link: string): string => {
  const hash = link.indexOf("#")

  return hash === -1 ? link : `${link.slice(0, hash + 1)}${"•".repeat(12)}`
}

/** Whether this browser offers a share sheet for links (most phones, some desktops). */
const canShareLink = (link: string): boolean => "share" in navigator && (navigator.canShare?.({ url: link }) ?? true)

/** A button that flips between two labels and reports its state to assistive technology. */
const toggleButton = (showLabel: string, hideLabel: string, controls: string, onChange: (shown: boolean) => void) => {
  const button = element("button", { type: "button", "aria-expanded": "false", "aria-controls": controls }, [showLabel])
  let shown = false
  button.addEventListener("click", () => {
    shown = !shown
    button.textContent = shown ? hideLabel : showLabel
    button.setAttribute("aria-expanded", String(shown))
    onChange(shown)
  })

  return button
}

export const sharePanel = (link: string): HTMLElement => {
  const linkField = element("input", { type: "text", readonly: "", id: "link", value: maskedLink(link), "aria-label": "Share link", autocomplete: "off" })
  const copy = element("button", { type: "button", class: "primary" }, ["Copy link"])

  const copyLink = async () => {
    // Undefined outside secure contexts, although the DOM types say otherwise.
    const clipboard: Clipboard | undefined = navigator.clipboard

    if (clipboard === undefined) {
      return
    }

    await clipboard.writeText(link)
    copy.textContent = "Copied"
  }

  copy.addEventListener("click", () => {
    void copyLink()
  })

  const revealLink = toggleButton("Show link", "Hide link", "link", (shown) => {
    linkField.value = shown ? link : maskedLink(link)
  })

  const qrFigure = element("figure", { class: "share-qr", id: "share-qr", hidden: "" }, [element("figcaption", {}, ["Scan to open on a phone"])])

  const showQr = async () => {
    // Drawn on first use only, so the secret is never rendered unless asked for.
    if (qrFigure.querySelector("svg") === null) {
      qrFigure.prepend(await qrCode(link))
    }

    qrFigure.hidden = false
  }

  const revealQr = toggleButton("Show QR code", "Hide QR code", "share-qr", (shown) => {
    if (shown) {
      void showQr()
    } else {
      qrFigure.hidden = true
    }
  })

  const actions = element("div", { class: "share-actions" }, [copy])

  if (canShareLink(link)) {
    const share = element("button", { type: "button" }, ["Share"])
    share.addEventListener("click", () => {
      // The text names no files: messaging apps keep what is shared, and file names are private.
      navigator.share({ title: "Files for you", text: "I sent you some files.", url: link }).catch(() => {
        // Closing the share sheet rejects; there is nothing to do.
      })
    })
    actions.append(share)
  }

  actions.append(revealLink, revealQr)

  return element("div", { class: "share" }, [
    element("label", { for: "link" }, ["Share this link"]),
    linkField,
    actions,
    element("p", { class: "share-warning" }, ["Anyone with this link can open the files until the transfer ends."]),
    qrFigure,
  ])
}
