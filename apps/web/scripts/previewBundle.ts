import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { build } from "vite-plus"
import type { Plugin } from "vite-plus"

// The opaque frame cannot send SameSite cookies with subresource requests. Bundle its
// code into the initial document, whose navigation can authenticate normally.
export const previewBundle = (): Plugin => {
  let root = ""

  return {
    name: "preview-bundle",
    apply: "build",
    configResolved(config) {
      root = config.root
    },
    async writeBundle(options) {
      const entry = path.resolve(root, "src/capabilities/preview/frame/entry.ts")
      const style = path.resolve(root, "src/capabilities/preview/frame/style.css")

      const result = await build({
        configFile: false,
        root,
        publicDir: false,
        plugins: [
          tailwindcss(),
          {
            name: "preview-entry",
            transform: (code, id) => (id === entry ? `import ${JSON.stringify(style)};\n${code}` : undefined),
          },
        ],
        build: {
          write: false,
          target: "es2023",
          lib: { entry, name: "Preview", formats: ["iife"] },
        },
      })

      const builds = Array.isArray(result) ? result : [result]

      if (builds.some((output) => !("output" in output))) {
        throw new Error("Unexpected preview build output")
      }

      const outputs = builds.flatMap((output) => ("output" in output ? output.output : []))
      const script = outputs.find((output) => output.type === "chunk")
      const css = outputs.find((output) => output.type === "asset" && output.fileName.endsWith(".css"))

      if (script === undefined || script.type !== "chunk" || css === undefined || css.type !== "asset") {
        throw new Error("The preview build did not produce its script and stylesheet")
      }

      const stylesheet = Buffer.from(css.source).toString("utf-8")

      if (/<\/script/iu.test(script.code) || /<\/style/iu.test(stylesheet)) {
        throw new Error("Preview assets cannot be embedded safely in HTML")
      }

      const scriptHash = createHash("sha256").update(script.code).digest("base64")
      const styleHash = createHash("sha256").update(stylesheet).digest("base64")
      const policy = `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'sha256-${styleHash}'; style-src-attr 'unsafe-inline'; img-src blob:; media-src blob:; base-uri 'none'; form-action 'none'`
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><title>Preview · Pocketdrop</title><style>${stylesheet}</style></head><body><div id="preview-app"></div><script>${script.code}</script></body></html>`
      const directory = options.dir ?? path.resolve(root, "dist")
      const headersPath = path.join(directory, "_headers")
      const headers = await readFile(headersPath, "utf-8")

      const updated = headers.replace(
        /(?<header>\/preview\*\n\s+Content-Security-Policy:) [^\n]*/u,
        `$<header> sandbox allow-scripts; ${policy}; frame-ancestors 'self'`,
      )

      if (updated === headers) {
        throw new Error("The preview CSP header rule is missing")
      }

      await Promise.all([writeFile(path.join(directory, "preview.html"), html), writeFile(headersPath, updated)])
    },
  }
}
