/**
 * Lint configuration. The Effect plugin's file roles and platforms are declared once, in effx.config.json, which the
 * `effx check` coordinator also reads; they mirror the package kinds of CLAUDE.md (docs/decisions/0009). Groups must be
 * disjoint, since they compile to overrides that merge rule by rule. Type-aware Effect diagnostics come from effect-tsgo.
 */
import { effect } from "@phibkro/oxlint-effect-plugin"
import type { EffectConfigInput } from "@phibkro/oxlint-effect-plugin"
import { defineConfig } from "oxlint"
import effxConfig from "./effx.config.json" with { type: "json" }

// SAFETY: effx.config.json is validated by effx itself (effx check fails on an invalid configuration).
export default defineConfig({
  ...effect(effxConfig.effect as EffectConfigInput),
  ignorePatterns: ["**/node_modules/**", "spikes/**", ".claude/**"],
})
