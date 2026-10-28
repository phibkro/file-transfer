/**
 * Vite+ (docs/decisions/0010): one toolchain for formatting, linting, type checking and tests. The Effect profile is
 * linted by `effx check`, which owns its escapes and import closure (docs/decisions/0009), so it is not repeated here.
 */
import { defineConfig } from "vite-plus"

export default defineConfig({
  fmt: { semi: false, printWidth: 160 },
  lint: {
    ignorePatterns: ["**/node_modules/**", "spikes/**"],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["libraries/*/test/**/*.test.ts", "services/*/test/**/*.test.ts", "platforms/*/test/**/*.test.ts", "integrations/*/test/**/*.test.ts", "tools/*/test/**/*.test.ts"],
  },
})
