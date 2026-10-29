# Security policy

This project moves people's files, so security reports are welcome and taken seriously. What the software protects, and what it does not, is described on the site's security page (`apps/web/security.html`) and in `docs/parcel.md` (the encrypted format) and `docs/design.md` (threat model).

## Reporting a vulnerability

Report privately through GitHub: the repository's **Security** tab, **Report a vulnerability**. Please include what you found, how to reproduce it, and what an attacker gains. You will get an answer within a week.

Please do not open public issues for vulnerabilities until a fix is released.

## Testing

Point any tool you like at the code, the format and its test vectors: fuzzers, static analysis, AI agents. To test a running service, deploy your own instance (see the site's "Run your own" page) and test that. Do not test instances that other people run, including send.phibkro.org, beyond normal use: no load tests, no scanning, no attempts to read other people's transfers.

## Scope

In scope: the parcel format and `libraries/parcel`, the web app (`apps/web`), the room server (`platforms/*`), and the build and deploy configuration in this repository.

Out of scope: problems that need a compromised device on the sender's or recipient's side, the fact that anyone holding a link can receive its files, and metadata the documentation already lists as visible to servers (sizes, timing, network addresses).

## Fixes

Fixes are welcome as pull requests. Changes to a frozen parcel version are not possible; a format flaw is fixed in a new version, with test vectors.
