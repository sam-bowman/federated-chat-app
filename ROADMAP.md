# Roadmap

A working list of planned features and infrastructure work, roughly grouped by
area. Nothing here is sequenced or committed to a timeline — it's a reference
for what's next, not a promise of when. See [README.md](README.md) for what's
already built, and its "What's not here yet" / "Known federation limitations"
sections for gaps already called out in more detail.

## Client applications

See [docs/distribution.md](docs/distribution.md) for the detailed matrix of client (and
server) packaging formats, status, and dependencies between them - desktop
apps and mobile apps shared one blocker (the home-server picker, now done),
spelled out there.

- ~~**Home-server picker on login**~~ **Done** - the client resolves
  `@user:domain` or a bare domain via `.well-known` before showing a login
  form (`client/src/pages/AuthPage.tsx`, `client/src/api/discovery.ts`), and
  remembers which server a saved session belongs to. Cleared the shared
  blocker for desktop, mobile, and the client Docker image's multi-server
  mode - see `docs/distribution.md`.
- **Push notifications** — follows directly from desktop/mobile: APNs/FCM
  integration, plus a server-side device-token registry and a "notify" path
  alongside the existing WebSocket/sync-event delivery
- **Multi-account support** — being logged into more than one
  identity/server at once in the same client, now that server-selection
  exists

## Federation & protocol

Closing gaps already documented in the README:

- ~~Federated group DMs~~ **Done** - `POST /federation/v1/conversations`
  now accepts a `GROUP` conversation spanning any number of distinct
  domains (2-10 members), not just a single remote peer. Every member is
  trusted differently depending on who's vouching for them: a member on
  the receiving server's own domain must already exist locally, a member
  on the calling peer's own domain is trusted directly (a peer is always
  authoritative for its own users), and a member on any other domain is
  independently verified against *that* domain's own `GET /users/{username}`
  rather than trusted from the payload - closes a cache-poisoning risk
  where a peer could otherwise plant a permanent, attacker-chosen
  `protocolId` for a real user on a domain it doesn't control. The
  multi-domain message/edit/delete/reaction fan-out this needed already
  existed (`getRemoteConversationDomains`, the per-domain `outbox.ts`
  queue) - the only real gap was this one receiving-side trust boundary.
  See [`protocol/federation.md`](protocol/federation.md#postconversations).
- ~~Federated communities~~ **Done** - join, leave, reading, and now
  sending/editing/deleting a message or reacting as a remote member all
  work across federation (a community has exactly one authoritative home
  server, unlike a DM; a remote member's own server holds a read cache
  only, kept current by relay from the home server - never independently
  authoritative). A federated reference is `<protocolId>:<domain>`, usable
  in the existing "Join by ID" field with no client changes. A remote
  member's write synchronously proxies to the home server
  (`server/src/lib/federation/proxy.ts`), which runs the real permission
  check and persists before responding - not an optimistic local accept
  that might get retracted. Still out of scope: a remote member exercising
  *management* permissions (roles/channels/kicks/bans) remotely - the
  home server's own owner can already manage a cached remote member
  locally with no new code. See
  [`protocol/federation.md`](protocol/federation.md#communities).
- ~~Remote message edit/delete/reaction propagation~~ **Done** - four new
  federation endpoints (`POST /messages/{id}/edit|delete|reactions[/remove]`,
  `server/src/modules/federation/routes.ts`) mirror the existing message-relay
  pattern; the local edit/delete/react routes
  (`server/src/modules/messages/routes.ts`) now relay to a federated DM's
  remote member the same way message send already did, through the same
  durable outbox. Client needed zero changes - the federation-received
  handlers emit the exact same WS sync events (`message:edited`,
  `message:deleted`, `message:reaction_added/removed`) the local routes
  already did, which `ConversationPage.tsx` already handled generically.
  Verified for real on the two-server demo: edited and deleted a message
  from alice.test, reacted and un-reacted from bob.test, watched each one
  land live on the other side. See
  [`protocol/federation.md`](protocol/federation.md#postmessagesidedit).
- ~~Durable federation outbox with retry/backfill~~ **Done** -
  `FederationOutboxEvent` (`server/src/lib/federation/outbox.ts`): friend
  requests, conversation handshakes, and message relays that fail to
  deliver are queued, not dropped - a capped-exponential-backoff
  background worker retries them, and any later successful call to that
  domain immediately flushes its whole backlog rather than waiting for
  each row's own timer. Deliberately excludes presence pushes (retrying a
  stale presence update once a peer's back up would deliver outdated
  status, not current). Verified for real on the two-server demo: killed
  `server-b`, sent a DM to the now-unreachable user (queued, not lost),
  restarted `server-b`, watched the queued message arrive on Bob's side
  automatically. See README "Known federation limitations".
- ~~Replay protection beyond the timestamp window~~ **Done** -
  `server/src/lib/federation/nonceCache.ts`: a federation request's
  signature is itself the nonce (unique per request, unforgeable without
  the origin's private key) - a signature seen once already is rejected
  outright (`401 replayed_federation_request`), even if its timestamp is
  still within the 5-minute window. Redis-backed when `REDIS_URL` is set
  (shared across replicas, same pattern as rate limiting), in-memory
  otherwise. A genuine retry re-signs with a fresh timestamp, so this only
  catches actual replays, never legitimate retries - verified via an
  integration test sending the exact same signed request twice. See
  [`protocol/federation.md`](protocol/federation.md#authentication).
- ~~A formal, versioned federation protocol spec doc~~ **Done** -
  `protocol/federation.md`: identity format, server discovery, request
  signing (the exact canonical string, headers, replay window), every
  `/federation/v1/*` endpoint's request/response shape and error codes,
  delivery semantics (at-least-once, idempotent on protocolId, the
  outbox's retry/backfill behavior, why presence is excluded from it),
  media reference absoluteness, and what protocol versioning means -
  written to be readable independently of this repo's own server code, so
  a third party could implement a compatible homeserver from it alone.

## Emoticons

- A third copy mode, distinct from the two that already exist
  (`server/src/modules/emoticons/routes.ts`): **save** (`EmoticonSave`) is
  a pure reference back to the original row - no independent identity, so
  an edit to the original is automatically visible to everyone who saved
  it, but you can't customize the image, only your own trigger. **Fork**
  (`POST /:id/fork`, `Emoticon.parentId`) creates a fully independent new
  row with its own id/trigger/image, tracked back to its parent for
  lineage only - it never changes again when the original does. Neither
  is "clone the image now, but keep it linked so I can choose to pull
  future edits" - that needs new state (something like
  `Emoticon.clonedFromId` + a last-synced marker, since "clone" has its
  own image that can diverge from the source, unlike a save) and a sync
  action (`POST /:id/sync-from-clone-source` or similar), plus a policy
  decision this hasn't needed before: does the clone's owner pull updates
  manually, or can the *original's* owner push them automatically (and if
  so, does the clone's own trigger/customizations survive that)?

## Voice chat

Not implemented at all today - `.well-known`'s discovery document already
advertises `"voice": false` (`protocol/federation.md`) as a placeholder for
this. Three distinct scopes, roughly increasing in difficulty:

- Voice channels within a community (a new `ChannelType` alongside the
  existing `TEXT`, plus whatever signaling/media transport layer - likely
  WebRTC with an SFU, this repo has no existing audio/media-streaming
  infrastructure to build on).
- Private voice chat mirroring DMs (1:1) and group DMs (already federated
  as of group DM federation - see "Federation & protocol" above).
- **Federated voice** specifically: unlike text, which only ever needs a
  signed HTTP relay between homeservers, real-time audio needs a live
  media path between participants on *different* servers - likely a much
  bigger lift than anything federation has needed so far (probably
  something like each homeserver running its own SFU and relaying/
  bridging streams between them, or participants connecting to a single
  session's SFU directly cross-server). Needs its own research/design pass
  before any implementation starts, not just an extension of the existing
  signed-REST federation model.

## Security & production hardening

- ~~Rate limiting~~ **Done** - `express-rate-limit`, Redis-backed when
  `REDIS_URL` is set (so a fleet of replicas shares one budget per client,
  not one per replica) and in-memory otherwise. A general limiter covers
  every `/api/v1` and `/federation/v1` route; a stricter one layers on top
  of `/api/v1/auth` specifically. Keys on `req.ip` - see README's "Rate
  limiting" section for the `trust proxy` caveat that matters behind a
  reverse proxy.
- ~~2FA/MFA~~ **Done** - TOTP (RFC 6238), compatible with any standard
  authenticator app. Setup/disable require re-entering your password (so a
  hijacked session alone can't enroll or remove it), login redeems a
  short-lived challenge token distinct from a real access token, and 10
  one-time recovery codes are issued for when the authenticator app isn't
  available. See README's "Two-factor authentication" section.
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
- ~~S3-compatible object storage abstraction~~ **Done** -
  `STORAGE_DRIVER=s3` (`server/src/lib/storage/`), an opt-in alternative
  to the local-disk default. Fixes the Helm chart's `replicaCount > 1` +
  `ReadWriteOnce` uploads limitation for real (every replica reads/writes
  the same bucket, no PVC-sharing problem to work around) - see the
  chart's own README "S3-compatible object storage" and
  `values.yaml`'s `server.storage`. Also fixed a real pre-existing bug
  found along the way: `PATCH /users/me`'s `avatarUrl` required
  `z.string().url()`, which rejected the relative `/uploads/x.png` URL
  the upload endpoint actually returns under the disk driver - setting an
  avatar through the UI was broken end to end, untested until now. See
  README "S3-compatible object storage".
- ~~**Dockerfiles** for `server/` and `client/`~~ **Done** -
  `server/Dockerfile` (multi-stage, runs `prisma migrate deploy` on
  container start) and `client/Dockerfile` (nginx, non-root, runtime-
  configurable `API_URL` via `env-config.js` so one built image works
  against any server - see README "Docker images"). Hit and fixed a real
  Prisma-on-Alpine OpenSSL auto-detection gap along the way (needed
  `binaryTargets` in `schema.prisma` *and* `apk add openssl` - the former
  alone silently wasn't enough).
- ~~**docker-compose.yml for full self-hosting**~~ **Done** -
  `docker-compose.selfhost.yml` + `.env.selfhost.example`, wiring the
  published server/client images together with Postgres (Redis opt-in via
  `--profile multi-replica`) - distinct from the existing dev-only compose
  file. Required secrets/domains (`JWT_ACCESS_SECRET`, `SERVER_DOMAIN`,
  etc.) fail `docker compose up` fast with a clear message if left unset,
  rather than silently falling back to an insecure dev default. Verified
  for real: a full register/login round-trip against the pulled images on
  a fresh stack. See README "Docker images".
- ~~Publish images to a registry~~ **Done** - GHCR, via
  `.github/workflows/publish-images.yml`, triggered by the `vX.Y.Z` tags
  release-please creates (see Release engineering below). Tagged by exact
  version, minor version, and `latest`.
- ~~**Helm chart**~~ **Done** - `charts/federated-chat-app/`, one umbrella
  chart for server + client, bundling plain Postgres/Redis Deployments
  (not an external chart dependency) so `helm install` alone gets a
  running stack; `postgresql.enabled: false` for a production-managed
  database instead. Verified for real on a local kind cluster: install,
  `helm test`, a register/login round-trip, then an upgrade confirming
  the Postgres volume survives a rolling restart. See
  [docs/distribution.md](docs/distribution.md) and the chart's own README. (Native
  server/client binaries and the Tauri desktop app, formerly listed here
  alongside this, are also ~~done~~ - see docs/distribution.md's "Native binary"/
  "Binary"/"Desktop app" rows and `.github/workflows/publish-binaries.yml` /
  `publish-desktop.yml`.)

## Release engineering

- ~~**Semver** versioning policy~~ **Done** - see `docs/versioning.md` (lockstep
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
- **Split `README.md`** - 19 top-level sections covering dev setup, 6
  different deployment targets (Docker, Kubernetes, native binaries,
  desktop app, multi-replica, the federation demo), 3 security features
  (rate limiting, password policy, 2FA), S3 storage, testing, architecture
  notes, and known limitations, all in one file. `docs/distribution.md`
  already does this for packaging formats (one matrix, linking out) -
  extend that pattern: README keeps a short overview + quickstart, each
  deployment target and each major feature gets its own guide under
  `docs/` (matching the one-topic-per-file precedent `docs/spec.md` and
  `protocol/federation.md` already set), and README links to them instead
  of containing them.
- **Per-deployment-model guides** - one doc each for local dev, Docker
  Compose self-hosting, Kubernetes/Helm, native binaries, and the desktop
  app, covering what README's relevant sections cover today but in more
  depth (troubleshooting, upgrade/rollback, resource sizing) - currently
  everything is a single pass with no room for that.
- ~~A guide for using the client~~ **Done** - `docs/client-guide.md`: an
  end-user walkthrough (account setup, friends/DMs, communities/channels,
  emoticons, 2FA) distinct from README/`docs/distribution.md`, which are
  entirely about building/deploying/developing the app rather than using
  it day to day.
- ~~Tidy the top-level repo listing~~ **Done** - `DISTRIBUTION.md` and
  `VERSIONING.md` moved to `docs/distribution.md`/`docs/versioning.md`
  (lowercase, matching `docs/spec.md`'s naming). `README.md`/`LICENSE`/
  `CONTRIBUTING.md`/`CHANGELOG.md` stay at the root (GitHub's own UI looks
  for them there), and `CLAUDE.md` stays because Claude Code reads it from
  the root specifically - five top-level `.md` files now, down from seven.
