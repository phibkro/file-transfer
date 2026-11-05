/**
 * Build and dev server for the web app. In development, `/api` (room creation and the room WebSocket) goes to the
 * platform under `wrangler dev` on port 8787; in production every platform serves `dist` as static assets, with
 * `/r/*` answered by `index.html`. `public/_headers` sets the headers Cloudflare's static assets serve (the preview
 * page's sandbox, CORS for the preview frame's scripts).
 */
import path from "node:path"
import { pathToFileURL } from "node:url"
import { foldkit } from "@foldkit/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { defineConfig } from "vite-plus"
import { fileRoutes } from "./scripts/fileRoutesPlugin.ts"
import { generateFileRoutesEffect, readRouteInventoryEffect } from "./scripts/fileRoutes.ts"
import type * as LayoutModule from "./scripts/layout.ts"

await Effect.runPromise(generateFileRoutesEffect(import.meta.dirname).pipe(Effect.provide(NodeServices.layer)))

const layoutUrl = pathToFileURL(path.resolve(import.meta.dirname, "scripts/layout.ts")).href

// SAFETY: This URL names the local layout module, loaded after route generation.
const { layout } = (await import(layoutUrl)) as typeof LayoutModule
const inventory = await Effect.runPromise(readRouteInventoryEffect(import.meta.dirname).pipe(Effect.provide(NodeServices.layer)))
const staticRoutes = inventory.filter((route) => route.staticPage)

export default defineConfig({
  plugins: [fileRoutes(), layout(), tailwindcss(), foldkit()],
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2023",
    rollupOptions: {
      // The app (including Library), the sandboxed preview frame, and the content pages.
      input: {
        main: "index.html",
        preview: "preview.html",
        ...Object.fromEntries(staticRoutes.map((route) => [route.path.slice(1), `${route.path.slice(1)}.html`])),
        admin: "admin.html",
      },
    },
  },
})
