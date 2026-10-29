---
---

Dependabot's pull requests no longer fail the checks for lack of an empty changeset or of the Preview deploy secrets, and Worker Previews now get the static asset headers and routing production has (a patch to Alchemy), so the checks can be required on main.

Checks now run once per pull request commit instead of twice: branch pushes no longer start their own run.
