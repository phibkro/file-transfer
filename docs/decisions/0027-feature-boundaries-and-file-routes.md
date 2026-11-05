# 0027: Organize browser features around typed file routes

Status: accepted by the product owner's request to reorganize the application and use a TanStack-style file routing API.

## Context

Browser features and their adapters previously occupied parallel root files and feature folders. This made ownership and shared dependencies difficult to find.

The application uses Foldkit 0.170.0 and Effect 4.1.0. Foldkit supplies typed route parsers and printers, but its installed Vite plugin has no file-route generator.

TanStack Router provides the desired declaration shape. Its generator targets React, Solid and Vue, not Foldkit. Adapting generated framework internals creates unnecessary coupling.

## Decision

Organize application composition, product features, browser capabilities, shared UI, site content and global styles separately. Keep each feature's Foldkit state and behavior together.

Portable capabilities remain in workspace libraries. Browser adapters live under their logical capability in the web application. Preserve runtime-specific boundaries when they enforce security or resource ownership.

Use app-local route declarations with `createRootRoute(options)` and `createFileRoute(fileIdentifier)(options)`. Route modules export `Route`. Generate typed routing artifacts from the route files rather than maintain another route inventory.

Use Foldkit's parser and printer primitives underneath the declarations. Do not introduce a second UI runtime or claim compatibility with TanStack's React hooks or Start server functions.

The root application owns the persistent workspace. Quick Share and Local Library share that workspace, including sender state, catalog state and transfer resources. Navigation does not create another application runtime.

Static information pages remain useful without JavaScript. The preview document retains its opaque sandbox, separate entry point and restricted content security policy.

Routing consumes pathnames only. The address adapter retains sole authority to read secret fragments. A route match never contains a link secret.

## Consequences

Route filenames determine URL structure. Generated types and URL builders keep callers consistent with that structure. Generation becomes part of development, builds and repository checks.

Feature movement does not change parcel bytes, transfer protocols, local consent or storage policy. Local Library remains device-only metadata indexing with explicit opt-in.

The file router is a Foldkit integration with a familiar declaration shape, not an implementation of Next.js, React Router or TanStack Start.

## Sources

- [TanStack createFileRoute](https://tanstack.com/router/latest/docs/api/router/createFileRouteFunction)
- [TanStack createRootRoute](https://tanstack.com/router/latest/docs/api/router/createRootRouteFunction)
- [TanStack file naming conventions](https://tanstack.com/router/latest/docs/routing/file-naming-conventions)
- [TanStack generator targets](https://github.com/TanStack/router/blob/main/packages/router-generator/src/config.ts)

No TanStack implementation code is copied.
