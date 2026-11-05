// Icon paths adapted from the operator-provided pocketdrop-source.zip (https://pocketdrop-design.philib-krogh.chatgpt.site/).
import type { Html, HtmlBuilder } from "foldkit/html"

const paths = {
  mark: "M3 7.5h18v12H3zM7 7.5l2.2-3h5.6l2.2 3M3 12h5l2 2h4l2-2h5",
  send: "M3 11.5 21 3l-5 18-4.2-7-8.8-2.5ZM21 3l-9.2 11",
  receive: "M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5",
  upload: "M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4",
  arrow: "M4 12h15m-6-6 6 6-6 6",
  plus: "M12 5v14M5 12h14",
  search: "M16 16l4 4M16 10.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z",
  clock: "M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0ZM12 7v5l3 2",
  file: "M6 3h8l4 4v14H6zM14 3v5h4m-9 5h6m-6 4h6",
  image: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 4v2m-4 7 5-4 3 2 4-5 5 5",
  check: "m5 12 4 4 10-10",
  close: "m6 6 12 12M18 6 6 18",
  copy: "M8 8h12v12H8zM16 8V4H4v12h4",
  history: "M4 10a8 8 0 1 1 1.5 7M4 4v6h6m2-3v5l3 2",
  github:
    "M9 19c-4 1-4-2-6-2m12 4v-3c0-1 .1-1.5-.5-2 3-.3 6.5-1.5 6.5-7A5.5 5.5 0 0 0 19.5 5 5 5 0 0 0 19 2s-1.5-.5-4 1a14 14 0 0 0-6 0C6.5 1.5 5 2 5 2a5 5 0 0 0-.5 3A5.5 5.5 0 0 0 3 9c0 5.5 3.5 6.7 6.5 7-.5.5-.5 1-.5 2v3",
  shield: "M12 3 20 6v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z",
  lock: "M5 11h14v10H5zM8 11V8a4 4 0 0 1 8 0v3m-4 4v2",
  folder: "M3 6h7l2 2h9v11H3z",
} as const

export const icon = <Message>(h: HtmlBuilder<Message>, name: keyof typeof paths, className = ""): Html =>
  h.svg([h.Class(`icon ${className}`), h.Attribute("viewBox", "0 0 24 24"), h.Attribute("aria-hidden", "true")], [h.path([h.Attribute("d", paths[name])])])
