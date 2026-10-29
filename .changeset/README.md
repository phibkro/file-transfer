# Changesets

Each pull request adds a file here describing its change and the semantic version bump of every package it changes: run `bunx changeset`, or `bunx changeset --empty` when it ships nothing. The release workflow turns them into versions and changelogs when they reach main. The rules, including what counts as a breaking change for the parcel format and the room protocol, are in [docs/versioning.md](../docs/versioning.md).
