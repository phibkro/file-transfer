import type { Plugin } from "vite-plus"
import { resolve, sep } from "node:path"
import { generateFileRoutes } from "./fileRoutes.ts"

export const fileRoutes = (): Plugin => {
  let root = ""
  return {
    name: "file-routes",
    enforce: "pre",
    async configResolved(config) {
      root = config.root
      await generateFileRoutes(root)
    },
    configureServer(server) {
      const directory = resolve(root, "src/routes") + sep
      server.watcher.add(directory)
      let pending = Promise.resolve()
      const regenerate = (file: string) => {
        if (!resolve(file).startsWith(directory)) return
        pending = pending.then(() => generateFileRoutes(root)).catch((error: unknown) => {
          server.config.logger.error(String(error))
        })
      }
      server.watcher.on("add", regenerate).on("change", regenerate).on("unlink", regenerate)
    },
  }
}
