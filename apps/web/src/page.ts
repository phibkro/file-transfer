/** Entry point of the content pages: they carry their text in HTML; this adds the shared header and footer. */
import { installSiteChrome } from "./site.ts"

const main = document.querySelector<HTMLElement>("main")

if (main !== null) {
  installSiteChrome(main)
}
