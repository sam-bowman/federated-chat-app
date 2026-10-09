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

This is automated by [release-please](https://github.com/googleapis/release-please)
(`.github/workflows/release-please.yml`, config in `release-please-config.json`).
There's nothing to do by hand beyond writing a good [Conventional
Commit](https://www.conventionalcommits.org/) PR title (see `CLAUDE.md`) - the
squash-merge commit message *is* what release-please reads.

1. Every push to `master` (i.e. every merged PR), release-please looks at the
   Conventional Commits since the last release and opens or updates a standing
   **Release PR** - something like `chore(release): v0.2.0` - containing the
   version bump (lockstep across all three `package.json` files, per the policy
   above) and the generated `CHANGELOG.md` entry, grouped into sections
   (Added/Fixed/Changed/...) by commit type.
2. That PR is just a normal PR: it has to pass the same required CI checks as
   anything else before it can be merged (this is why the workflow uses a PAT,
   not the default token - see the comment in `release-please.yml`).
3. **Merge it whenever you're ready to release** - this is the one deliberate
   manual step, and it's what controls release *timing*. Nothing releases
   itself on an arbitrary schedule; commits just accumulate in the standing PR
   until you merge it.
4. Merging triggers release-please again, which tags the resulting commit
   (`vX.Y.Z`) and creates the GitHub Release from the same changelog entry.
5. That same tag push also triggers four independent, parallel workflows,
   with no ordering between them: `.github/workflows/publish-images.yml`
   (builds and pushes `server`/`client` Docker images to GHCR, tagged with
   the exact version and the minor version - see README "Docker images"),
   `.github/workflows/publish-binaries.yml` (builds and uploads native
   `server`/`client` binaries for Windows/Linux/macOS as GitHub Release
   assets - see `DISTRIBUTION.md`'s "Native binary"/"Binary" rows),
   `.github/workflows/publish-desktop.yml` (builds and uploads the Tauri
   desktop app the same way - see `DISTRIBUTION.md`'s "Desktop app" row),
   and `.github/workflows/publish-helm-chart.yml` (packages
   `charts/federated-chat-app` and pushes it to GHCR as an OCI artifact -
   see README "Kubernetes (Helm chart)").
6. `client/src-tauri/tauri.conf.json`, `client/src-tauri/Cargo.toml`, and
   `charts/federated-chat-app/Chart.yaml` (both its `version` and
   `appVersion` fields) all stay in the same version lockstep as the three
   `package.json` files (`release-please-config.json`'s `extra-files`) -
   the desktop app's own displayed version (installer metadata, "About"
   dialogs) and the Helm chart's default image tag (`appVersion`, via
   `values.yaml`'s `image.tag` falling back to `.Chart.AppVersion`) both
   track the rest of the release automatically, nothing to update by hand.

If no commit since the last release would actually bump the version (e.g. only
`chore`/`ci`/`docs` commits, which are excluded from the changelog by
`changelog-sections` in the config but still don't warrant a release), no
Release PR is opened at all.
