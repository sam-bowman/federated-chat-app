# Security policy

## Reporting a vulnerability

Please report it **privately**, not in a public issue or pull request.

Use GitHub's private vulnerability reporting: on the repository's **Security** tab choose
[**Report a vulnerability**](https://github.com/sam-bowman/federated-chat-app/security/advisories/new).
Only the maintainer sees the report, and any fix and advisory are worked out in the same private place.

A useful report says:

- what you found and what an attacker gains from it,
- the version (the app's version, or the image tag or commit) and how the server is run (Docker Compose, Kubernetes, a native binary, `npm run dev`),
- the steps to reproduce it, with the smallest request or message that shows it,
- whether it needs an account, and whether it needs to be an account on another server.

Please do not test against servers you do not run, and do not read, change or delete other people's data to prove a point: a
server of your own (the `docker-compose.yml` or the federation demo in the README) is all that is needed.

## What to expect

This is maintained by one person, so there is no support contract. The aim is to **answer within a week**, say whether it is
treated as a vulnerability, and then keep you up to date. A fix goes out as a normal release, with a published advisory that names
the versions affected and, if you want it, credits you. Please give the fix a reasonable chance to reach people who run servers
before you publish details; if a report has had no answer for two weeks, a short public issue asking for contact (with no details)
is fine.

## What is supported

Fixes are made for **the latest release** only. The project is before 1.0 and releases are frequent, so upgrading is the fix; see
[docs/deployment/upgrading-and-backups.md](docs/deployment/upgrading-and-backups.md) and [docs/versioning.md](docs/versioning.md).
Federation between servers has its own protocol version (also in `docs/versioning.md`): a flaw in the protocol itself is in scope
whichever app version you found it in.

## What counts

In scope, for example: a way to read or change another person's data, to act as another person or another server, to get an admin or
community permission you were not given, to make a server fetch something internal (SSRF), to run code on a server, to make a
server unavailable with little effort from one client, or to get past a limit documented in [docs/security.md](docs/security.md).

Usually **not** a vulnerability, though still welcome as an ordinary issue:

- things already listed as known limitations in [docs/federation-architecture.md](docs/federation-architecture.md) and the deployment guides
  (for example, voice audio is not end-to-end encrypted, and the unsigned desktop installers),
- an operator choosing an unsafe setting that the documentation warns about,
- findings that need a person to already control the server, the database or the host,
- missing hardening headers or similar with no demonstrated effect,
- reports from an automated scanner with no explanation of how it can be exploited.

## What is already checked

Each pull request runs CodeQL, a dependency audit and review, and a secret scan, and the end-to-end and integration tests include
regression tests for earlier security fixes. That is not a promise of no bugs; it is why a report that one of those would catch is
worth sending anyway, as it means a gap in them.
