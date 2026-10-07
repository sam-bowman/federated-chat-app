# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers
follow the policy in [VERSIONING.md](VERSIONING.md).

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-10-07

First documented baseline. This release predates the versioning policy and
`CHANGELOG.md` itself, so this entry is a retrospective summary of everything
shipped before this file started being kept - going forward, entries land
under `[Unreleased]` as they're merged, not reconstructed after the fact.

### Added

- Core single-server platform: `@username:domain` identity, registration,
  login with JWT access/refresh tokens, friends (requests, friendships,
  blocking), presence (online/away/busy/DND/invisible/offline + custom
  status), 1:1 and group DMs, communities with channels/roles/permissions,
  personal and community emoticons with saving and forking, and an offline
  delivery outbox (`SyncEvent`) so clients catch up on reconnect.
- Server discovery via `GET /.well-known/communication-platform`.
- Real server-to-server federation between independently-run homeservers:
  signed Ed25519 HTTP requests, peer discovery and caching, federated friend
  requests, 1:1 DMs, and live presence. See README "Architecture notes —
  federation" and "Known federation limitations" for what federation
  deliberately doesn't cover yet (group DMs/communities, remote
  edit/delete/reaction propagation, a durable retry queue).
- Redis-backed cross-replica presence/WebSocket fan-out, opt-in via
  `REDIS_URL` - lets more than one server replica run behind a load
  balancer with correct realtime delivery and fleet-wide presence tracking.
  A single replica never touches Redis.
- Full automated test suite: unit tests for pure logic (identity parsing,
  federation request signing, permission bitmasks, serialization) and
  integration tests running the real app against real Postgres and Redis,
  including several regression tests written directly against bugs found
  during manual testing (see Fixed, below) and a cross-replica fan-out proof.
- CI pipeline (lint, typecheck+build, unit/integration tests with an
  enforced coverage floor, `npm audit`, dependency review, secret scanning,
  CodeQL) gating all merges to `master` via a branch ruleset.
- Local dev tooling: `scripts/start.ps1`/`stop.ps1` for a single instance,
  `scripts/start-federation-demo.ps1`/`stop-federation-demo.ps1` for two
  independent homeservers talking to each other.
- Issue and PR templates, `CLAUDE.md`, `ROADMAP.md`, and an MIT `LICENSE`.

### Changed

- Redesigned the message list to a Discord-style full-width layout (was
  chat bubbles).

### Fixed

- Presence getting stuck permanently online after logout, and (separately)
  stuck offline after a WebSocket reconnect used an unrefreshed access
  token.
- Emoticons being invisible to message recipients (resolved against the
  wrong user's accessible set).
- Messages from one conversation/channel briefly appearing in a different,
  unrelated open thread.
- `publicUser()` leaking a user's true `INVISIBLE` presence status to
  anyone fetching it over REST, even though the live WebSocket broadcast
  already masked it as `OFFLINE` - found while writing the test suite
  above, not from manual testing.

### Security

- Federation requests are signed (Ed25519) and verified, with timestamp-based
  replay protection and conversation-membership checks on inbound messages.
- CI enforces `npm audit`, GitHub Dependency Review, gitleaks secret
  scanning, and CodeQL static analysis on every change.
