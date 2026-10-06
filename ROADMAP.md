# Roadmap

A working list of planned features and infrastructure work, roughly grouped by
area. Nothing here is sequenced or committed to a timeline — it's a reference
for what's next, not a promise of when. See [README.md](README.md) for what's
already built, and its "What's not here yet" / "Known federation limitations"
sections for gaps already called out in more detail.

## Client applications

- **Desktop apps** (Windows/Mac/Linux) — needs a packaging decision (Electron
  vs. Tauri are the two realistic options for wrapping the existing React
  client; Tauri gives a much smaller binary and lower memory footprint,
  Electron has the more mature ecosystem)
- **Mobile apps** (iOS/Android) — bigger lift than desktop; realistically a
  separate React Native codebase rather than a wrapped web view, given the
  amount of realtime/WebSocket/background-notification work involved
- **Home-server picker on login** — the client needs to resolve
  `@user:domain` or a bare domain via `.well-known` before showing a login
  form, and remember which server a saved session belongs to (today the
  client hardcodes `VITE_API_URL`)
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

- Rate limiting
- 2FA/MFA
- Admin/moderation web UI (today there's no way to moderate beyond
  per-community kick/ban)
- Content reporting/moderation queue (matters more once federation means
  untrusted servers can push content in)
- Audit logging for moderation/admin actions
- Account data export + deletion (GDPR-shaped, relevant the moment this is
  self-hostable by other people)

## Infrastructure & deployment

- **Fix in-memory presence/WS state before multi-replica deployment** -
  presence and realtime delivery (`server/src/ws/gateway.ts`,
  `server/src/modules/presence/presenceStore.ts`) are tracked entirely
  in-process today. A client connected to one replica never hears about an
  event handled by another, so this has to be solved (likely Redis pub/sub
  for cross-replica WS fan-out) *before* the Helm chart below can actually
  run more than one replica correctly - it's a prerequisite, not a
  nice-to-have.
- S3-compatible object storage abstraction (already a known gap - also
  relevant to desktop/mobile needing reliable media URLs, not just local
  disk)
- **Dockerfiles** for `server/` and `client/` (today's `docker-compose.yml`
  only runs Postgres - the apps themselves aren't containerized at all yet)
- **docker-compose.yml for full self-hosting** (server + client + Postgres
  together) - distinct from the existing dev-only Postgres compose file
- Publish images to a registry (GHCR is the natural choice, already using
  GitHub for everything else) wired into the release pipeline
- **Helm chart** for Kubernetes deployment
- Horizontal scaling story once presence is fixed (likely Redis pub/sub for
  cross-replica WS fan-out)

## Release engineering

- **Semver** versioning policy
- `CHANGELOG.md`, ideally generated from Conventional Commits (already in
  use - see `CLAUDE.md`) rather than hand-maintained
- Git tag → GitHub Release automation, probably tied to the image-publish
  step above

## Documentation

- `CONTRIBUTING.md` (issue/PR templates exist, but there's no guide for a
  first-time contributor)
- API reference (OpenAPI/Swagger) for the REST surface - currently only
  discoverable by reading route code
