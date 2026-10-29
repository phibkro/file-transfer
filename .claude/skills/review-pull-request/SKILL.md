---
name: review-pull-request
description: Independently verify a pull request in this repository and post one verdict (PASS, PASS+NOTES or FAIL) with proof. Drives the change like a user with verify-file-transfer, tries to break it, proves the one fact it is safe because of, and checks the repository's own rules. Use when asked to review, verify or approve a pull request. Must be run by an agent that did not write the change.
---

# Review a pull request

Adapted from pstack (cursor/plugins, MIT, copyright 2026 Lauren Tan; licence in `.claude/skills/PSTACK-LICENSE.txt`): the independent verdict from the `shipping` playbook, adversarial findings proven by runs from `interrogate`, and the one safety fact from `blast-radius`. pstack has no single pull request review skill; this combines those three for this repository. The severity scale, the pass rule and the review loop come from phibkro/vektorprogrammet-reimagined (`.agents/skills/review-pr`, same author), rewritten for a security product.

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
- **Verification skill in step**: a user-facing change whose journeys or handles are missing from `verify-file-transfer` (its feature map, a journey, a handle) is a `maintenance` finding of medium severity, even when the code is right.

## Severity

Give every verified finding one severity. When unsure between two, take the higher and say why.

| Severity | Meaning in this repository | Examples |
| --- | --- | --- |
| critical | Weakens the one invariant or a confidentiality or integrity invariant (`docs/invariants.md`, C1 to C7, I1 to I5), or breaks main or a release once merged | a key, the link fragment, a file name or plaintext reaching a server path, log, store, CI artifact or counter; a script or Content-Security-Policy change that lets other code run on the app's origin (threat T3); changed parcel v1 bytes; a leaked credential; a release that no longer publishes |
| high | Behaviour a user relies on is wrong, the evidence for a critical invariant is weakened, or a seam changes incompatibly | a transfer that stalls or ends with different bytes; a broken liveness or resource bound (L, R invariants); a negative control removed; a room protocol, HTTP API or parcel change without its version bump (docs/versioning.md); a parcel change without test vectors and property tests |
| medium | A rule of CLAUDE.md broken, the verification skill out of step, or evidence that does not match the branch | a missing changeset; a type assertion without `// SAFETY:`; a journey or handle the feature map lacks (`maintenance`); a pull request body claiming a run the branch cannot reproduce |
| low | Clarity or maintainability with no behavioural effect | a misleading name or comment; a doc sentence that is unclear but not wrong |
| nit | Taste | |

- A suspected critical that cannot be run here (it needs production, a real phone, a second machine) is reported as **unproven critical** and fails the review until a run disproves it or the owner accepts it in writing on the pull request.
- Only the owner downgrades a finding, by saying so on the pull request; the reviewer never does it to reach a pass.

## 4. The one fact it is safe because of

Most changes that look risky are safe because of one fact (for example "the deadline fires only while the socket is current and not joined"). Name it and prove it as far down this ladder as is cheap, saying where it stopped: (1) stated, (2) a `file:line`, (3) walked through every path, (4) a script or test that runs the real code and fails loudly if wrong, (5) reproduced in the running app. If you cannot prove it, write unproven.

## 5. Verdict

- **FAIL**: any open finding of medium, high or critical (an unproven critical included), a journey that fails at the head, or red checks on the head.
- **PASS+NOTES**: only low findings, nits or notes (a follow-up, a journey that could not run and why, a safety fact proven only to step 2).
- **PASS**: no finding, the journeys pass at the head, and the safety fact proven to step 3 or further.

Post it as one comment on the pull request (`gh api repos/{owner}/{repo}/issues/<n>/comments -F body=@<file>`; `-F` reads the file, while `-f` would post the literal text `@<file>`), in this shape:

```markdown
<!-- review round=<n> head=<full head sha> verdict=<pass | pass-with-notes | fail> -->
## Review: <PASS | PASS+NOTES | FAIL> at <head sha, 12 characters>

**Intent.** <two or three sentences>

**Verification.** <journey, origin or preview commit, result line; or why none applies>

**Safe because.** <the one fact>, proven to step <n>: <the command and what it printed>

**Findings.** <for each: severity, title, the exact command, the output, the output the intent requires> or "No verified findings."

**Notes.** <PASS+NOTES only>

**Dropped.** <ideas tried and dropped, and why, in one line each>

Reviewed by an agent that did not write this change, with .claude/skills/review-pull-request.
```

A verdict covers its commit only. If the head changes, the review must be redone (or the new patch compared with `git patch-id` and only the difference reviewed). The marker on the first line names that commit, so anyone (or a merge helper) can check that the head being merged is the one that passed.

## 6. The review loop

Run by the agent that coordinates the work, not by a reviewer:

1. **Round n**: one or more reviewers, each a fresh agent that did not write the change and did not review an earlier round, run this skill and post their verdict with `round=n` in the marker. A diff that touches the parcel, key handling, the room protocol, the HTTP API or the Content-Security-Policy gets two reviewers.
2. **Pass**: every reviewer's verdict for the head is PASS or PASS+NOTES. The pull request then waits for the owner; passing a review never merges it.
3. **Otherwise**: a fixer, a separate agent that is not a reviewer, gets the findings verbatim, fixes them on the branch (including `maintenance` findings in the verification skill), pushes, and answers each finding on the pull request. Then round n+1 with fresh reviewers.
4. **Limits**: after round 3, continue only while a critical or high finding is open; with only medium or lower left, stop and report the pull request, the open findings and the rounds to the owner. A finding that the same fix has failed twice goes to the owner at once, whatever the round.
