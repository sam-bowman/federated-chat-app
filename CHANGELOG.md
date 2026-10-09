# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers
follow the policy in [VERSIONING.md](VERSIONING.md).

Entries from `0.1.0` onward are generated automatically by
[release-please](https://github.com/googleapis/release-please) from
Conventional Commit PR titles - see `VERSIONING.md` for how a release actually
gets cut. Don't hand-edit below this point; a manual edit would just get
overwritten by the next generated entry.

## [0.6.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.5.1...v0.6.0) (2026-10-09)


### Added

* add a Helm chart for Kubernetes deployment ([#26](https://github.com/sam-bowman/federated-chat-app/issues/26)) ([c066275](https://github.com/sam-bowman/federated-chat-app/commit/c0662753dceaf8e4455315a3968ccd6f321c8a1f))
* add docker-compose.yml for self-hosting ([#24](https://github.com/sam-bowman/federated-chat-app/issues/24)) ([5915d1f](https://github.com/sam-bowman/federated-chat-app/commit/5915d1fad7e3299fcee884c0e91ccb62a444d3ce))
* add S3-compatible object storage abstraction ([#27](https://github.com/sam-bowman/federated-chat-app/issues/27)) ([8cff55c](https://github.com/sam-bowman/federated-chat-app/commit/8cff55c507d8f979507237777910acf075ddc862))
* **federation:** add a durable outbox with retry and backfill ([#28](https://github.com/sam-bowman/federated-chat-app/issues/28)) ([f851d20](https://github.com/sam-bowman/federated-chat-app/commit/f851d20565454d904bfaeac5576ec01bc8a6cc5d))

## [0.5.1](https://github.com/sam-bowman/federated-chat-app/compare/v0.5.0...v0.5.1) (2026-10-08)


### Fixed

* resolve critical SSRF and 49 missing-rate-limiting CodeQL alerts ([#21](https://github.com/sam-bowman/federated-chat-app/issues/21)) ([9eeab6b](https://github.com/sam-bowman/federated-chat-app/commit/9eeab6bdc7f1c800be993d3a1d3b68f715e33d40))

## [0.5.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.4.0...v0.5.0) (2026-10-08)


### Added

* **client:** add a desktop app via Tauri ([#19](https://github.com/sam-bowman/federated-chat-app/issues/19)) ([cc8b788](https://github.com/sam-bowman/federated-chat-app/commit/cc8b7882cc074e0b22386affc1cd0258e1b02857))

## [0.4.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.3.1...v0.4.0) (2026-10-08)


### Added

* **client:** add a home-server picker before login ([#14](https://github.com/sam-bowman/federated-chat-app/issues/14)) ([856cfdb](https://github.com/sam-bowman/federated-chat-app/commit/856cfdb36e5275c2f969738899e795c0c82442f6))
* **client:** package the web client as a native binary ([#16](https://github.com/sam-bowman/federated-chat-app/issues/16)) ([9250bac](https://github.com/sam-bowman/federated-chat-app/commit/9250bac1c6f7a28251f946038b274ab99b7d07e7))
* **server:** package the server as a native binary ([#17](https://github.com/sam-bowman/federated-chat-app/issues/17)) ([369b258](https://github.com/sam-bowman/federated-chat-app/commit/369b25898b83250c1585f84c60acb33eccb6b448))

## [0.3.1](https://github.com/sam-bowman/federated-chat-app/compare/v0.3.0...v0.3.1) (2026-10-07)


### Fixed

* **client:** stop multi-arch Docker build hanging on arm64 ([#12](https://github.com/sam-bowman/federated-chat-app/issues/12)) ([41fad0e](https://github.com/sam-bowman/federated-chat-app/commit/41fad0ea81d42023c51b9950b4f200bccd4fbf94))

## [0.3.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.2.0...v0.3.0) (2026-10-07)


### Added

* publish multi-arch (amd64/arm64) Docker images ([#10](https://github.com/sam-bowman/federated-chat-app/issues/10)) ([17ac28d](https://github.com/sam-bowman/federated-chat-app/commit/17ac28d259bd836d6218208817d8e555d158606b))

## [0.2.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.1.0...v0.2.0) (2026-10-07)


### Added

* add Dockerfiles and publish images to GHCR on release ([#8](https://github.com/sam-bowman/federated-chat-app/issues/8)) ([8e2af5b](https://github.com/sam-bowman/federated-chat-app/commit/8e2af5b5fbe58ceded914cf59c38e2c5ac9350ae))
* **server:** add Redis-backed cross-replica presence/WS fan-out ([#4](https://github.com/sam-bowman/federated-chat-app/issues/4)) ([0e0cc87](https://github.com/sam-bowman/federated-chat-app/commit/0e0cc872e210e3717e5f55b9ec4dfc66d2907cd4))

## [0.1.0] - 2026-10-07

First documented baseline, written by hand before release-please existed - a
retrospective summary of everything shipped before this file started being
kept. Every entry after this one is generated automatically.

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
