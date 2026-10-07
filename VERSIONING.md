# Versioning policy

This project follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`),
applied **lockstep across the whole repo** - `package.json`, `server/package.json`,
and `client/package.json` always carry the same version number. There's no
"client 1.4.0 against server 1.2.0" compatibility matrix to reason about: if you're
running a given tag, server and client are the versions that were tested together at
that tag.

## This is not the federation protocol version

`config.protocolVersion` (`server/src/config.ts`, currently `"0.1.0"`) is a
**separate** number from the app version above. It governs wire compatibility
between independently-run homeservers - it changes only when the federation
protocol itself changes in a way that affects interop with another server, which
is a much rarer event than an app release. Don't confuse the two: bumping the app
version on every release does not imply the protocol version changed, and vice
versa.

## What bumps what

This repo is pre-1.0 (`0.y.z`). Per semver's own rules for initial development,
**breaking changes bump MINOR, not MAJOR**, until 1.0.0:

- **PATCH** (`0.1.x`) - bug fixes, dependency bumps, doc-only changes: nothing a
  self-hoster needs to act on beyond pulling the new version.
- **MINOR** (`0.x.0`) - new features, and (pre-1.0 only) breaking changes too:
  a new required env var, a schema migration needing more than `prisma migrate
  deploy`, a changed API response shape, a federation protocol version bump.
  Always called out explicitly in `CHANGELOG.md` with upgrade notes when it's
  the breaking-change case, not the purely-additive one.
- **MAJOR** - reserved for 1.0.0 and beyond, once there's an actual compatibility
  promise to break. Pre-1.0, nothing bumps MAJOR.

**1.0.0** isn't tied to a specific date or feature checklist - informally, it's
when the federation protocol (identity, discovery, friends/DMs/presence - see
README "Architecture notes — federation") is considered stable enough that a
different, independent implementation could reasonably target it without
expecting it to shift under them.

## How a release is cut

There's no automated release pipeline yet (see `ROADMAP.md` → Release
engineering) - today this is manual:

1. Decide the bump (above) from what's in `CHANGELOG.md`'s `[Unreleased]`
   section since the last release.
2. Move those entries under a new `## [X.Y.Z] - YYYY-MM-DD` heading in
   `CHANGELOG.md`.
3. Bump the version in all three `package.json` files to match (lockstep -
   see above).
4. Open a PR with just that (`chore(release): vX.Y.Z`), merge it once CI is
   green.
5. Tag the resulting commit on `master`: `git tag vX.Y.Z && git push origin
   vX.Y.Z`, and create a GitHub Release from it using the `CHANGELOG.md`
   section as the release notes.

Commit messages already follow [Conventional
Commits](https://www.conventionalcommits.org/) (see `CLAUDE.md`) - a `feat:`
PR title generally means the next release is at least a MINOR bump, `fix:`
means PATCH, but the actual decision happens at release-cut time against the
accumulated `CHANGELOG.md` entries, not automatically per-commit.
