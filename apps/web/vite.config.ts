/**
 * Build and dev server for the web app. In development, `/api` (room creation and the room WebSocket) goes to the
 * platform under `wrangler dev` on port 8787; in production every platform serves `dist` as static assets, with
 * `/r/*` answered by `index.html`. `public/_headers` sets the headers Cloudflare's static assets serve (the preview
 * page's sandbox, CORS for the preview frame's scripts).
 */
import { defineConfig } from "vite-plus"

export default defineConfig({
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
      // The app, and the sandboxed page previews render in (src/preview.ts).
      input: { main: "index.html", preview: "preview.html" },
    },
  },
})
