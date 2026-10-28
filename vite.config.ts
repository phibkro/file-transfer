/**
 * Vite+ (docs/decisions/0010): one toolchain for formatting, linting, type checking and tests. The Effect profile is
 * linted by `effx check`, which owns its escapes and import closure (docs/decisions/0009), so it is not repeated here.
 *
 * Lint: Ultracite's oxlint core and anti-slop presets (docs/decisions/0014), run by `vp check --deny-warnings`. Rules
 * turned off below conflict with this codebase on purpose; each line says why.
 */
import antiSlop from "ultracite/oxlint/anti-slop"
import core from "ultracite/oxlint/core"
import { defineConfig } from "vite-plus"

export default defineConfig({
  fmt: { semi: false, printWidth: 160, ignorePatterns: [".claude/**"] },
  lint: {
    extends: [core, antiSlop],
    ignorePatterns: [
      "**/node_modules/**",
      "**/dist/**",
      "spikes/**",
      ".claude/**",
      // Generated from the Unicode 15.1 character database; regenerated, never edited by hand.
      "libraries/parcel/src/unicode.ts",
    ],
    options: { typeAware: true, typeCheck: true },
    rules: {
      // Object key order is meaningful: the parcel's canonical manifest JSON is written in declaration order.
      "eslint/sort-keys": "off",
      // Byte, hash and record code (parcel, transport) is bitwise by nature.
      "eslint/no-bitwise": "off",
      // Records are read, sealed and sent one after another on purpose (streaming, backpressure, ordered writes).
      "eslint/no-await-in-loop": "off",
      // Effect.gen takes anonymous `function*` bodies by convention.
      "eslint/func-names": "off",
      // Index loops over bytes and records read best with ++.
      "eslint/no-plusplus": "off",
    },
  },
  test: {
    include: [
      "libraries/*/test/**/*.test.ts",
      "services/*/test/**/*.test.ts",
      "platforms/*/test/**/*.test.ts",
      "integrations/*/test/**/*.test.ts",
      "tools/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
    ],
  },
})
