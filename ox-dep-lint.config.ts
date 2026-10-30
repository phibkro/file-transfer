/**
 * The package-kind table of CLAUDE.md as ox-dep-lint's configuration (docs/decisions/0009). `bun run check:graph` runs
 * the CLI over the whole workspace; `vite.config.ts` loads the same configuration into the oxlint plugin, so the editor
 * and `vp check` report the per-file findings where they are written.
 */
import { defineConfig } from "ox-dep-lint"

export default defineConfig({
  workspaceScopes: ["@file-transfer/"],
  kinds: {
    // Valibot: wire contracts the browser decodes, as Standard Schema without Effect's size (docs/decisions/0020).
    library: { packages: ["libraries/*"], mayUse: ["library"], externals: ["effect", "valibot"], runtimeModules: false },
    service: { packages: ["services/*"], mayUse: ["library"], externals: ["effect"], runtimeModules: false },
    platform: { packages: ["platforms/*"], mayUse: ["service", "library", "integration"] },
    integration: { packages: ["integrations/*"], mayUse: ["library"] },
    app: { packages: ["apps/*"], mayUse: ["library"] },
    tool: { packages: ["tools/*"], mayUse: "any" },
  },
  // The conformance suite's entry is shipped as a source of tests, so it may import the test-only modules.
  packages: { "@file-transfer/conformance": { testSupportFiles: ["src/index.ts"] } },
  // Files that never ship: tests, development scripts and deployment declarations. Package-root configuration files
  // (vite.config.ts) stay shipped, as before.
  fileClasses: [{ files: ["test/**", "scripts/**", "**/*.test.ts", "alchemy.run.ts"], policy: "development" }],
  testOnlySpecifiers: ["vite-plus/test", "bun:test", "fast-check", "effect/testing", "@file-transfer/conformance"],
  // Shipped code takes outside packages from dependencies only.
  imports: { shippedFields: ["dependencies"], typeOnly: "as-values" },
  // The self-hosted platform's built web client, copied in by its build.
  ignore: ["platforms/self-hosted/public/**"],
})
