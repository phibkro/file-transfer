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
      // Repository file names are camelCase (moduleGraph.ts, endToEnd.ts).
      "unicorn/filename-case": "off",
      // Wrapping event and callback APIs (WebSocket events, stream controllers) needs the Promise constructor.
      "promise/avoid-new": "off",
      // A Node callback convention; it misreads the transition function `next` of libraries/machine.
      "node/callback-return": "off",
      // Protocol dispatchers are flat switches over message types; the count measures breadth, not tangle.
      "eslint/complexity": "off",
      // Switches over tagged unions are exhaustive and checked by typescript/switch-exhaustiveness-check; a default would hide a missing case.
      "eslint/default-case": "off",
      // TypeScript checks every return path against the declared return type, Effect.gen's `return yield*` included.
      "typescript/consistent-return": "off",
      // Effect convention: a service's tagged error classes live next to it.
      "eslint/max-classes-per-file": "off",
      // Misreads Effect.forEach(iterable, f) as Array#forEach with a this argument.
      "unicorn/no-array-method-this-argument": "off",
      // Effect Schema convention: a schema value and its type share one name.
      "eslint/no-redeclare": "off",
      // Byte-level code: Latin-1 strings from atob and hex strings are UTF-16 code units by design.
      "unicorn/prefer-code-point": "off",
      // promise-function-async makes functions that meet an async contract without awaiting (in-memory readers, test doubles) async.
      "eslint/require-await": "off",
      // Assertions follow anti-slop's policy instead: each states its checked invariant in a SAFETY comment.
      "typescript/no-unsafe-type-assertion": "off",
      // TypeScript already rejects use before declaration (TS2448); what remains are closures that run later.
      "eslint/no-use-before-define": "off",
      // Destructuring into existing variables needs a parenthesised statement; keep it for declarations only.
      "eslint/prefer-destructuring": ["error", { VariableDeclarator: { array: false, object: true }, AssignmentExpression: { array: false, object: false } }],
      // Loops in async code wait on state that event handlers change during the awaits inside them.
      "eslint/no-unmodified-loop-condition": "off",
      // `void promise;` as a statement marks a deliberate fire-and-forget, which no-floating-promises then accepts.
      "eslint/no-void": ["error", { allowAsStatement: true }],
    },
    overrides: [
      {
        files: effectFiles,
        // Ultracite wants `async` on every Promise-returning function; effx forbids native async in Effect code.
        rules: { "typescript/promise-function-async": "off" },
      },
      {
        files: ["libraries/parcel/src/manifest.ts", "platforms/cloudflare/src/room.ts"],
        // Parsers of untrusted JSON (the manifest, room creation and control messages): the I/O boundary anti-slop asks
        // code to parse at, so they take unknown and narrow it with typeof.
        rules: {
          "anti-slop/no-unknown-parameters": "off",
          "anti-slop/no-runtime-typeof": "off",
          "anti-slop/no-unsafe-dictionary-type": "off",
        },
      },
      {
        files: ["platforms/cloudflare/src/workers.d.ts"],
        // Hand-written mirror of Cloudflare's declarations: their method signatures, overloads and unknown-typed values.
        rules: {
          "typescript/method-signature-style": "off",
          "anti-slop/no-unknown-parameters": "off",
          "anti-slop/no-unknown-returns": "off",
          "typescript/no-unnecessary-type-parameters": "off",
          "typescript/prefer-function-type": "off",
        },
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
