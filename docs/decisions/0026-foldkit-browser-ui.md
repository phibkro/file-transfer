# 0026: Use Foldkit for the browser UI

Status: accepted, 2026-11-04, by the product owner's explicit request for the complete UI to use Foldkit and Foldkit UI.

## Context

The browser application includes batched selection and renaming, direct/relayed sessions, verified downloads, sandboxed previews, settings, operator counts and site pages. Local Library adds durable metadata, transient file capabilities, collection editing and asynchronous version approvals. Hand-maintained DOM rendering makes these state and lifetime boundaries harder to own.

ADR 0020 removed Effect from the browser to reduce client JavaScript. The current-main production main chunk at this decision's baseline is 89.20 kB raw (34.95 kB gzip), with an additional shared view chunk of 10.77 kB raw (3.30 kB gzip). Foldkit introduces a larger runtime; this is a deliberate architecture/capability tradeoff, not an accidental dependency change.

## Decision

- Use Foldkit 0.170.0 with compatible Effect 4.1 for UI Models, Messages, updates, views and lifetimes. Use Foldkit UI components for the interactions they already implement, rather than maintaining parallel event/rendering machinery.
- Apply this to transfer, Library, operator and sandbox preview UI, and render the shared layout/information pages with Foldkit while preserving useful static/no-JavaScript information pages.
- Preserve current protocol and transfer implementations. Sessions remain browser adapters and retain current recipient transitions, direct-path fallback, ordering, locks and completion behavior. Foldkit owns their UI-facing acquisition and release.
- Preserve ADR 0020's Valibot/Standard Schema wire contracts. This decision supersedes only its prohibition on Effect in browser UI code. Do not replace wire decoders with a second set of UI Schemas.
- Keep every file key, fragment, filename, operator credential and sensitive snapshot out of server paths and development diagnostics. Opaque Effect Redacted values serialize only to non-restorable private markers; normal development JSON must not expose their contents. The isolated preview frame keeps diagnostics disabled.
- Install the official Vite plugin, DevTools/MCP integration and recommended Oxlint plugin without replacing Vite+, Ultracite, ox-dep-lint, knip, Effect checks or release gates.

## Consequences

The application has one UI state/rendering architecture and explicit resource owners, at the cost of a larger client runtime. Production build output measures the resulting footprint. Static information pages keep their no-JavaScript use case, and the operator chart stays an existing isolated uPlot widget owned by a Foldkit Mount, not a new chart implementation.

Local Library remains opt-in metadata/reference indexing, never an implicit upload or a copied-file store. An empty derived default collection requires no retained file data. Hosted cloud storage remains a separately gated future feature.
