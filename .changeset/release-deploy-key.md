---
---

Releases push their commit and tags with a deploy key on main's ruleset bypass list, kept in a `release` environment that only main can use, since the workflow's own token cannot pass the ruleset.
