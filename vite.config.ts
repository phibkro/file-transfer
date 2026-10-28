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
import effxConfig from "./effx.config.json" with { type: "json" }

/** Files effx governs as Effect code, where `Effect.promise(() => f())` is the idiom and native async is rejected. */
const effectFiles = effxConfig.effect.groups.filter((group) => group.role === "effect-library" || group.role === "service").flatMap((group) => group.files)

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
      // Its fix turns typed-array copies (`bytes.slice()`) into number arrays (`[...bytes]`).
      "unicorn/prefer-spread": "off",
      // Its fix deletes `undefined` arguments TypeScript requires (a machine's `Context` of `undefined`, AsyncGenerator.return).
      "unicorn/no-useless-undefined": "off",
    },
    overrides: [
      {
        files: effectFiles,
        // Ultracite wants `async` on every Promise-returning function; effx forbids native async in Effect code.
        rules: { "typescript/promise-function-async": "off" },
      },
      {
        files: ["platforms/cloudflare/src/workers.d.ts"],
        // Hand-written mirror of Cloudflare's declarations, which use method signatures and overloads.
        rules: { "typescript/method-signature-style": "off" },
      },
    ],
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
