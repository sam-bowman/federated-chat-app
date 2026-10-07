# Contributing

Thanks for taking a look at this project. It's an early-stage, mostly-solo-maintained
MVP, so process here is intentionally lightweight - but a few things are enforced by
the repo itself (CI, branch rules), not just convention, so this doc tells you what
those actually are before you hit them in a PR.

## Getting set up

See [README.md](README.md) "Getting started" for the full walkthrough -
`.\scripts\start.ps1` brings up Postgres, the server, and the client in one go. If
you're touching federation code, also read "Federation demo" in the same file. If
you're touching presence/WebSocket fan-out across multiple replicas, see "Running
multiple replicas".

You'll need Docker (for Postgres, and optionally Redis) and Node 22+.

## Before you open a PR

1. **Find or file an issue first** for anything non-trivial (a new feature, a
   behavior change, anything bigger than a typo fix) using the [bug
   report](.github/ISSUE_TEMPLATE/bug_report.yml) or [feature
   request](.github/ISSUE_TEMPLATE/feature_request.yml) template. Saves everyone
   the awkwardness of a large PR built on an approach that wouldn't have been
   accepted.
2. **Branch off `master`**, naming it `<type>/<short-description>` - see
   [CLAUDE.md](CLAUDE.md) "Git workflow" for the exact convention and the full list
   of commit types. `master` itself is protected: direct pushes are rejected, for
   everyone, no exceptions.
3. **Write Conventional Commits.** Every commit, not just the PR title - though the
   PR title matters most, since this repo merges by squash and the title becomes
   the commit message on `master`. See CLAUDE.md for examples.
4. **Add tests.** See README "Testing" for how the suite is organized (unit vs.
   integration) and "Testing philosophy" in CLAUDE.md for the house style: several
   existing tests are regressions written directly against real bugs, each with a
   comment explaining the original bug and why the test catches it. If you're
   fixing a bug, add a test in that style rather than just describing the fix in
   prose.
5. **Add a `CHANGELOG.md` entry** under `[Unreleased]` for anything a user or
   self-hoster would care about (new behavior, a fix, a breaking change) - skip it
   for pure internal refactors, CI tweaks, or typo fixes. See
   [VERSIONING.md](VERSIONING.md) for how entries eventually turn into a release.
6. **Update docs** if behavior, setup steps, or a known limitation changed -
   `README.md` is the main one; `ROADMAP.md` if you've closed out something listed
   there.

## Opening the PR

Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md) (it should load
automatically) - it asks what CI already checks for you versus what you verified
manually, since CI can't click through the UI or run the federation demo for you.

CI runs lint, typecheck+build, unit tests, integration tests (with an enforced
coverage floor - see README "Testing" → "Coverage"), `npm audit`, a dependency
review, secret scanning, and CodeQL, all required to pass before merge. There's no
required human review (solo-maintainer repo, and GitHub won't let anyone approve
their own PR anyway) - **passing CI is the actual gate**. Merges are squash-only, so
your branch's own commit history can be as messy as you like mid-PR; the title is
what ends up on `master`.

## Code style

- TypeScript strict mode, no implicit `any`.
- Default to **no comments**. Add one only when the *why* isn't obvious from the
  code itself - a non-obvious constraint, a workaround, something that would
  surprise a future reader. Don't describe *what* the code does; well-named
  identifiers already do that.
- Don't add abstractions, config options, or error handling for cases that can't
  happen. Match the existing patterns in the module you're editing before
  introducing a new one.

## Federation protocol changes

If you're changing anything under `server/src/lib/federation/` or
`server/src/modules/federation/` in a way that affects the wire format (not just
internal implementation), see [VERSIONING.md](VERSIONING.md) - the federation
protocol version is tracked separately from the app version, and a wire-breaking
change needs to bump it.

## Reporting a security issue

If it's a genuine vulnerability (not just a "known limitation" already documented
in the README), please don't open a public issue - the README's federation and
security sections are a good place to check first in case it's already a
documented, deliberate gap rather than a bug.
