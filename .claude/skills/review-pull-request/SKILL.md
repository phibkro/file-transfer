---
name: review-pull-request
description: Independently verify a pull request in this repository and post one verdict (PASS, PASS+NOTES or FAIL) with proof. Drives the change like a user with verify-file-transfer, tries to break it, proves the one fact it is safe because of, and checks the repository's own rules. Use when asked to review, verify or approve a pull request. Must be run by an agent that did not write the change.
---

# Review a pull request

Adapted from pstack (cursor/plugins, MIT, copyright 2026 Lauren Tan; licence in `.claude/skills/PSTACK-LICENSE.txt`): the independent verdict from the `shipping` playbook, adversarial findings proven by runs from `interrogate`, and the one safety fact from `blast-radius`. pstack has no single pull request review skill; this combines those three for this repository.

Green CI and an approving bot are not verdicts: neither runs the change as a user would. A verdict counts only from an agent that did not write the code, because an author checks what it meant to build. Report findings; do not fix them, push to the branch, approve, or merge.

## 1. Frame

- Scope: the pull request's diff from its merge base with `main` (`gh api repos/{owner}/{repo}/pulls/<n>` for head and base, `git diff <base>...<head>`). Record the head SHA: the verdict covers that commit only.
- Intent: restate in two or three sentences what the change promises, from the title, body, commits and any linked spike or decision record. If the intent is unclear, say so in the verdict rather than guessing.
- Read CLAUDE.md, and the docs the diff touches.

## 2. Run it like a user

- Pick the `verify-file-transfer` journeys the change can affect (features/README.md). A docs-only change needs none; say so.
- Drive them at the head: the pull request's preview (the bot's `Preview: ... (commit <sha>)` comment, only if `<sha>` is the head) or a local instance launched from a checkout of the head. For a behaviour change, also drive the same journey at the base, so the verdict can say what changed.
- Keep each journey's `PASS` or `FAIL` line, origin and commit for the verdict.

## 3. Try to break it

Write down how the change could fail its intent, then prove or drop each idea with a run against the real code: a failing test, a script, a journey variation, command output. Keep a finding only when the output shows a failure that breaks the intent. Leave out anything you did not run: style, naming, structure, and risks that need a future change to matter. No findings is a valid result.

Repository rules to check, each by evidence rather than impression:

- **The one invariant** (CLAUDE.md): no URL fragment, key, file name or plaintext logged, stored or sent on any server path. For a server or protocol change, grep the diff's server paths and run `send-receive` (its `sent.json` check).
- **Parcel** (`libraries/parcel`): every change has test vectors and property tests (round trip, truncation, reordering, record swapping, wrong key); parcel v1 is frozen.
- **Changeset**: present, names every package whose shipped files changed, and the bump matches docs/versioning.md for seams (parcel, room protocol, HTTP API).
- **Checks**: `bun run check` passes at the head (run it, or read the head's CI and say which).
- **Docs**: claims in changed docs match the code; no em-dashes.

## 4. The one fact it is safe because of

Most changes that look risky are safe because of one fact (for example "the deadline fires only while the socket is current and not joined"). Name it and prove it as far down this ladder as is cheap, saying where it stopped: (1) stated, (2) a `file:line`, (3) walked through every path, (4) a script or test that runs the real code and fails loudly if wrong, (5) reproduced in the running app. If you cannot prove it, write unproven.

## 5. Verdict

- **PASS**: the journeys pass at the head, no verified finding, the safety fact proven to step 3 or further.
- **PASS+NOTES**: as PASS, with notes that do not break the intent (a follow-up, an unproven but low-risk fact, a journey that could not run and why).
- **FAIL**: a verified finding breaks the intent, a journey fails at the head, or a repository rule is broken.

Post it as one comment on the pull request (`gh api repos/{owner}/{repo}/issues/<n>/comments -F body=@<file>`; `-F` reads the file, while `-f` would post the literal text `@<file>`), in this shape:

```markdown
## Review: <PASS | PASS+NOTES | FAIL> at <head sha, 12 characters>

**Intent.** <two or three sentences>

**Verification.** <journey, origin or preview commit, result line; or why none applies>

**Safe because.** <the one fact>, proven to step <n>: <the command and what it printed>

**Findings.** <for each: title, the exact command, the output, the output the intent requires> or "No verified findings."

**Notes.** <PASS+NOTES only>

**Dropped.** <ideas tried and dropped, and why, in one line each>

Reviewed by an agent that did not write this change, with .claude/skills/review-pull-request.
```

A verdict covers its commit only. If the head changes, the review must be redone (or the new patch compared with `git patch-id` and only the difference reviewed).
