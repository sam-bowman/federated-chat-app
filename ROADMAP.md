# Roadmap

A working list of planned features and infrastructure work, roughly grouped by
area. Nothing here is sequenced or committed to a timeline — it's a reference
for what's next, not a promise of when. See [README.md](README.md) for what's
already built, and its "What's not here yet" / "Known federation limitations"
sections for gaps already called out in more detail.

## Client applications

See [DISTRIBUTION.md](DISTRIBUTION.md) for the detailed matrix of client (and
server) packaging formats, status, and dependencies between them - desktop
apps and mobile apps shared one blocker (the home-server picker, now done),
spelled out there.

- ~~**Home-server picker on login**~~ **Done** - the client resolves
  `@user:domain` or a bare domain via `.well-known` before showing a login
  form (`client/src/pages/AuthPage.tsx`, `client/src/api/discovery.ts`), and
  remembers which server a saved session belongs to. Cleared the shared
  blocker for desktop, mobile, and the client Docker image's multi-server
  mode - see `DISTRIBUTION.md`.
- **Push notifications** — follows directly from desktop/mobile: APNs/FCM
  integration, plus a server-side device-token registry and a "notify" path
  alongside the existing WebSocket/sync-event delivery
- **Multi-account support** — being logged into more than one
  identity/server at once in the same client, now that server-selection
  exists

## Federation & protocol

Closing gaps already documented in the README:

- Federated group DMs and communities (today federation covers 1:1 DMs only)
- Remote message edit/delete/reaction propagation (currently only the
  initial send relays)
- Durable federation outbox with retry/backfill (today a failed delivery to
  a down peer is just lost)
- Replay protection beyond the timestamp window (nonce cache)
- A formal, versioned federation protocol spec doc (the `protocol/` dir
  exists but is empty — worth writing once the shape stabilizes, since other
  servers will eventually need to implement it independently)

## Security & production hardening

- ~~Rate limiting~~ **Done** - `express-rate-limit`, Redis-backed when
  `REDIS_URL` is set (so a fleet of replicas shares one budget per client,
  not one per replica) and in-memory otherwise. A general limiter covers
  every `/api/v1` and `/federation/v1` route; a stricter one layers on top
  of `/api/v1/auth` specifically. Keys on `req.ip` - see README's "Rate
  limiting" section for the `trust proxy` caveat that matters behind a
  reverse proxy.
- 2FA/MFA
- Admin/moderation web UI (today there's no way to moderate beyond
  per-community kick/ban)
- Content reporting/moderation queue (matters more once federation means
  untrusted servers can push content in)
- Audit logging for moderation/admin actions
- Account data export + deletion (GDPR-shaped, relevant the moment this is
  self-hostable by other people)

## Infrastructure & deployment

- ~~Fix in-memory presence/WS state before multi-replica deployment~~ **Done** -
  presence and realtime delivery now fan out across replicas via Redis
  pub/sub when `REDIS_URL` is set (see README "Running multiple replicas",
  `server/src/ws/presenceFanout.ts`). This was the prerequisite blocking the
  Helm chart below from actually working with more than one replica; that
  blocker is now cleared.
- S3-compatible object storage abstraction (already a known gap - also
  relevant to desktop/mobile needing reliable media URLs, not just local
  disk)
- ~~**Dockerfiles** for `server/` and `client/`~~ **Done** -
  `server/Dockerfile` (multi-stage, runs `prisma migrate deploy` on
  container start) and `client/Dockerfile` (nginx, non-root, runtime-
  configurable `API_URL` via `env-config.js` so one built image works
  against any server - see README "Docker images"). Hit and fixed a real
  Prisma-on-Alpine OpenSSL auto-detection gap along the way (needed
  `binaryTargets` in `schema.prisma` *and* `apk add openssl` - the former
  alone silently wasn't enough).
- **docker-compose.yml for full self-hosting** (server + client + Postgres
  together, Redis if running multiple server replicas) - distinct from the
  existing dev-only compose file. Natural next step now that the images
  exist, not yet built.
- ~~Publish images to a registry~~ **Done** - GHCR, via
  `.github/workflows/publish-images.yml`, triggered by the `vX.Y.Z` tags
  release-please creates (see Release engineering below). Tagged by exact
  version, minor version, and `latest`.
- **Helm chart(s)** for Kubernetes deployment - see
  [DISTRIBUTION.md](DISTRIBUTION.md). The presence/WS prerequisite is done, so
  it can actually run `replicas > 1` correctly whenever it's built. (Native
  server/client binaries and the Tauri desktop app, formerly listed here
  alongside this, are ~~done~~ - see DISTRIBUTION.md's "Native binary"/
  "Binary"/"Desktop app" rows and `.github/workflows/publish-binaries.yml` /
  `publish-desktop.yml`.)

## Release engineering

- ~~**Semver** versioning policy~~ **Done** - see `VERSIONING.md` (lockstep
  across the repo, pre-1.0 breaking changes bump MINOR not MAJOR).
- ~~`CHANGELOG.md`~~ **Done**, and superseded - originally hand-maintained
  (Keep a Changelog format), now auto-generated by release-please (below)
  from Conventional Commit PR titles instead.
- ~~Git tag → GitHub Release automation~~ **Done**, and now tied to image
  publishing too - via [release-please](https://github.com/googleapis/release-please)
  (`.github/workflows/release-please.yml`): a standing Release PR
  accumulates version bump + changelog as commits land, merging it tags,
  publishes the GitHub Release, and that tag push triggers
  `publish-images.yml` (Infrastructure, above).

## Documentation

- ~~`CONTRIBUTING.md`~~ **Done**
- API reference (OpenAPI/Swagger) for the REST surface - currently only
  discoverable by reading route code
