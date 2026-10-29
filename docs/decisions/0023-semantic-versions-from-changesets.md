# 0023 Semantic versions and changelogs from changesets, released from main

Status: accepted (2026-10-29). Amends ADR 0021 (releases came from hand-pushed version tags).

## Context

The product owner asked for releases of the executables and images on every update to main, checks on pull requests that prove those artifacts work, and a changelog in the workflow: every pull request describes its change and its semantic version, so versions mean something, above all for seams such as the parcel format and versioned APIs.

Changesets (MIT, @changesets/cli 3.0.3, read 2026-10-29 from changesets.dev and its source) is the established tool for this in monorepos: each pull request adds a small file naming packages, a bump and a description; `changeset version` turns the waiting files into version bumps and CHANGELOG.md sections, with dependents bumped along. It supports Bun workspaces through @manypkg ("supports Yarn, npm, Lerna, pnpm, Bun, Rush"), and private packages that are never published, with `privatePackages: { version: true, tag: true }`. Two things it does not do: `changeset status` fails only when packages changed and no changeset exists at all, not when a changed package is missing from the changesets; and changesets/action opens a "Version Packages" pull request, which would make every release wait for a person.

## Decision

1. **Changesets for versions and changelogs**, configured in `.changeset/config.json`: private packages versioned and tagged, Changesets' own formatting off (the repository's formatter formats the changelogs), `tools/quality` never versioned.
2. **Two version lines** (docs/versioning.md): the product (apps, platforms, services) shares one version through `fixed` and releases as `vX.Y.Z`; each library keeps its own and is tagged `<package>@X.Y.Z`. The seam libraries (parcel, transport) start at 1.0.0 and follow SemVer strictly; the product stays below 1.0.0, where a breaking change bumps the minor version, until 1.0.0 is a decision of its own.
3. **Every pull request adds a changeset**, empty when it ships nothing. Our own check (`bun run check:changesets`, `tools/quality/src/changesets.ts`) also requires every package whose shipped files changed to be named, and lists the bumps of seam packages for the reviewer, since no tool can tell whether a change to a wire format is compatible.
4. **Releases come from main without a release pull request.** When `checks` passes on a push to main and changesets are waiting, `release.yml` versions, commits `Release vX.Y.Z` to main and tags it, with notes gathered into the root CHANGELOG.md. The tag's push starts `publish.yml`, which builds and smoke-tests the artifacts from the tag and publishes the GitHub release (amended 2026-10-29: building from the tag's own push, rather than from a commit handed to a reusable workflow, closes CodeQL's cache-poisoning alerts on artifacts.yml). A push with no changesets waiting releases nothing.
5. **Pull requests build what a release ships**: the executables on all four platforms with their smoke test, the web client, and the container for amd64 and arm64 (`artifacts.yml`, `checks.yml`).

## Consequences

- The release workflow pushes to main, which a ruleset protects. A workflow's token cannot bypass a ruleset, so the push uses a deploy key on the bypass list, kept in a `release` environment only main may use (docs/versioning.md, Release key). A GitHub App would do the same with short-lived tokens, at the cost of creating and maintaining the App.
- A deploy key's push starts workflows, so `checks` runs on the release commit and production deploys it; the release run it starts finds no changesets and stops.
- Pull requests take longer: the macOS and Windows executables build in parallel with the other checks, a few minutes each.
- Changesets is a development dependency of the repository root; the product does not ship it.
