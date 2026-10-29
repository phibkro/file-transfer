---
name: open-pull-request
description: Open a pull request in this repository the way its reviewers expect, with a narrow, checked change, a changeset, verification evidence from verify-file-transfer, and a one-minute body (Why, What changed, Scope, Tradeoffs, Blast Radius, Verification). Use whenever you are about to push a branch and open a pull request here.
---

# Open a pull request

Adapted from pstack's `opening-a-pr` playbook (cursor/plugins, MIT, copyright 2026 Lauren Tan; licence in `.claude/skills/PSTACK-LICENSE.txt`). Changes: this repository's checks, changesets and title convention, and verification through `verify-file-transfer`.

## Before you open it

1. **Branch from main**, one branch per change. Prefer five narrow pull requests to one large one; each commit tells one step of the story, and each pull request lands on its own.
2. **Prove it works the way a user would.** Run the `verify-file-transfer` journeys the change touches against a local instance at your head (`launch.ts`, `doctor.ts`, `drive.ts`, `stop.ts`). For a bug fix, show the failure first: the journey or test fails on `main`'s code and passes on yours. A change no journey reaches says so in Verification and names the test that covers it instead.
3. **Run the repository's checks**: `bun run check` (format, type check, lint, module graph, Effect lint, tests). Fix, do not suppress.
4. **Add a changeset**: `bunx changeset` naming every package whose shipped files changed with its bump (docs/versioning.md; the parcel format, room protocol and HTTP API have their own rules), or `bunx changeset --empty` with a one-line description when nothing ships. Commit, then `bun run check:changesets` must report 0 violations.
5. **Re-read the diff adversarially**: what would CI, a reviewer, or CLAUDE.md's invariant reject? No URL fragment, key, file name or plaintext on any server path; no em-dashes in docs or comments; full-word names; `// SAFETY:` on every type assertion. Fix it before pushing.

## Title

This repository's convention, not Conventional Commits: one imperative sentence that says what the change does for the product, capitalised, no trailing period, for example `Give up a socket whose join the room never answers`. The squash merge appends the pull request number.

## Body

A one-minute briefing for a reviewer who has the diff, not a lab notebook. Short, plain sentences, few identifiers. Use `##` headings in this order and drop a section with nothing to say:

- `## Why`: the problem and the approach, 1 to 3 sentences. Link the finding, issue or spike it comes from.
- `## What changed`: 1 to 3 bullets. Name a real symbol or path only when it carries the change.
- `## Scope`: always. What it covers and what it deliberately leaves out (a follow-up, a known gap).
- `## Tradeoffs`: only rejected alternatives a reviewer would otherwise ask about.
- `## Blast Radius`: 1 to 2 sentences on what it touches and the one fact that makes it safe (or what makes it risky).
- `## Verification`: 1 to 3 bullets, each a real run and its outcome: the journey or command, where it ran (local revision or preview commit), and the result line, red first for a fix. Performance: one number, `before → after`.

End with the attribution lines the session asks for. Long evidence (logs, screenshots, run notes) goes in a comment or artifact, not the body.

## Opening

- Use the REST API (`gh api repos/{owner}/{repo}/pulls -X POST -f head=... -f base=main -f title=... -f body=...`); GraphQL is unavailable in some sessions.
- Open it ready, never as a draft.
- Opening a pull request does not merge it. Merging needs the owner's approval for that pull request, every time.
- After opening, the pull request needs an independent review: `review-pull-request`, run by an agent that did not write the change.
