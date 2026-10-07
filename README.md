# My Chat App

[![CI](https://github.com/sam-bowman/federated-chat-app/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/sam-bowman/federated-chat-app/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/sam-bowman/federated-chat-app)](https://github.com/sam-bowman/federated-chat-app/commits/master)
[![Open issues](https://img.shields.io/github/issues/sam-bowman/federated-chat-app)](https://github.com/sam-bowman/federated-chat-app/issues)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](server/tsconfig.json)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](client/package.json)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?logo=postgresql&logoColor=white)](docker-compose.yml)

An MVP of a federated, open-source communication platform — Discord-style communities
and channels, MSN-style friends/presence/DMs, and user-created emoticons — with real
**server-to-server federation**: two independently-run homeservers can discover each
other and let their users friend, DM, and see each other's live presence across the
server boundary, over a signed HTTP protocol (see
[Architecture notes](#architecture-notes--federation) below).

This is Phase 1+2 (and a slice of Phase 3/4) of the platform described in the
[product spec](docs/spec.md): identity, a homeserver, friends, presence, 1:1/group
DMs, communities with channels and roles, custom emoticons with saving/forking, and
federated discovery/friends/DMs/presence between two homeservers. Federated
communities, voice, and E2EE are **not** implemented yet — see
[What's not here yet](#whats-not-here-yet).

## Stack

- **Server**: Node.js + TypeScript, Express, `ws` (WebSockets), Prisma + PostgreSQL, JWT auth.
- **Client**: React + TypeScript + Vite, React Router.
- **Dev infra**: Docker Compose (PostgreSQL only — the app itself runs natively for fast iteration).

## Project layout

```text
server/   Express API + WebSocket gateway + Prisma schema/migrations
client/   React web client (Vite)
docker-compose.yml   PostgreSQL for local dev
```

## Getting started

### The easy way: start/stop scripts

```powershell
.\scripts\start.ps1   # brings up Postgres (Docker), the server, and the client
.\scripts\stop.ps1    # shuts everything down (your data is kept in a Docker volume)
```

`start.ps1` launches Docker Desktop if it isn't running, starts Postgres, creates
`server/.env` and `client/.env` from their `.env.example` files the first time, runs
`npm install` if needed, applies Prisma migrations, and starts the server
(`http://localhost:4000`) and client (`http://localhost:5173`) as background
processes — logs land in `.run\server.log` / `.run\client.log`, and it's safe to
re-run (it won't start a second copy of something already listening on its port).

`stop.ps1` kills those two background processes and stops/removes the Postgres
container. It does **not** delete your data — that lives in the
`my-chat-app_postgres-data` Docker volume, so the next `start.ps1` picks up right
where you left off.

### The manual way

### 1. Start PostgreSQL

```bash
docker compose up -d postgres
```

> This repo's `docker-compose.yml` maps Postgres to **host port 5433** (not 5432),
> because many dev machines already have a native PostgreSQL install listening on
> 5432. If 5433 is also taken on your machine, change the port mapping in
> `docker-compose.yml` and the port in `server/.env` to match.

### 2. Configure and run the server

```bash
cd server
cp .env.example .env     # defaults work out of the box for local dev
npm install
npm run prisma:migrate   # creates the database schema
npm run dev               # starts on http://localhost:4000
```

### 3. Configure and run the client

```bash
cd client
cp .env.example .env     # points at http://localhost:4000 by default
npm install
npm run dev               # starts on http://localhost:5173
```

Open `http://localhost:5173`, register a user (e.g. `alice`), and start adding
friends, DMs, and communities. Registering a second user (in a **separate browser
profile or incognito window** — see note below) lets you test friend requests, DMs,
and realtime delivery between two accounts.

> **Note on multiple accounts**: auth tokens are stored in `localStorage`, which is
> shared across tabs in the same browser profile — exactly like most web apps. To be
> logged in as two different users at once, use two separate browser profiles (or one
> normal + one incognito window), not two tabs in the same profile.

## Federation demo: two servers talking to each other

This spins up **two separate homeservers** — `alice.test` and `bob.test` — each with
its own database, running as genuinely independent processes, so you can see real
server-to-server federation rather than a single-server simulation of it.

```powershell
.\scripts\start-federation-demo.ps1   # brings up both homeservers + both clients
.\scripts\stop-federation-demo.ps1    # stops all four processes + the Postgres container
```

This is a separate pair of scripts from `start.ps1`/`stop.ps1`, using its own
`chat_a`/`chat_b` databases, its own `server/.env.a`/`.env.b` and
`client/.env.a`/`.env.b` (created from `.env.a.example`/`.env.b.example` the first
time, same pattern as the regular `.env`), and its own PID files. The two setups can
run at the same time, since they share the one Postgres container (`docker compose up`
is idempotent) — but `stop-federation-demo.ps1` stops that shared container, so don't
run it while you still want the single-instance app (`start.ps1`) up too; just stop
its own two processes by PID in that case instead.

Once it's up:

1. Open `http://localhost:5173` and register a user, e.g. `alice` (this is
   `alice.test`'s client).
2. Open `http://localhost:5174` in a **different browser profile or incognito
   window** (same `localStorage` caveat as above, now across two different origins
   too) and register a user, e.g. `bob` (this is `bob.test`'s client).
3. From either side, add the other as a friend using their full identity —
   `@bob:bob.test` from Alice's client, or `@alice:alice.test` from Bob's — in the
   "Add a friend" box on the Friends page.
4. Accept the request on the other side. You're now friends across two independent
   servers.
5. Click **Message** to open a federated DM and send messages both ways — each
   server relays the message to the other's `/federation/v1/messages` inbox.
6. Change your presence status (Settings → Presence) on one side and watch it update
   live on the other's friends list, with no page refresh — that's a
   `/federation/v1/presence` push arriving over the live WebSocket.
7. **Restart resilience**: stop one server (`taskkill /PID <pid> /T /F` using its
   `.run\server-a.pid` / `server-b.pid`, or just close its window if you started it
   another way) and send a message to that now-unreachable user. It sends fine on your
   own side — the local write always succeeds — but the other server, being down,
   never receives it (see [Known federation limitations](#known-federation-limitations)).
   Restart it with `start-federation-demo.ps1` again (it only restarts whatever isn't
   already listening); new messages flow normally again immediately, and the other
   server was never affected by the outage in the first place.

Each server's own `.well-known/communication-platform` document
(`http://localhost:4000/.well-known/communication-platform` /
`:4001/...`) advertises its federation API base and Ed25519 public key; that's what
the other server fetches (and caches) the first time it needs to talk to a new peer
domain.

Since there's no real DNS for `alice.test`/`bob.test` on a dev machine, each server's
`FEDERATION_PEER_OVERRIDES` env var (JSON, dev-only) maps those domains straight to
the other's real `localhost` URL instead of doing a live DNS/TLS lookup.

### What this demo does *not* cover

Consistent with this phase's explicit scope (see [Known federation
limitations](#known-federation-limitations) below): group DMs and communities aren't
federated, and a remote user editing/deleting a message or reacting to one doesn't
propagate back to you.

## Running multiple replicas

By default this server keeps presence and realtime WebSocket delivery entirely
in-process - correct and simplest for the common case of one replica. Set
`REDIS_URL` to run more than one replica of the *same* homeserver behind a load
balancer (not to be confused with the federation demo above, which runs two
*different* homeservers):

```bash
docker compose up -d redis   # local dev Redis, mapped to host port 6380
```

```env
REDIS_URL=redis://localhost:6380
```

With it set, every replica publishes outgoing events (messages, presence
changes, typing) to a shared Redis pub/sub channel instead of writing straight
to its own in-memory socket map, and every replica (including the one that
published) delivers to whichever of the target users it has locally connected -
so a message sent while handling a request on replica A still reaches a user
whose live socket happens to be open on replica B. Fleet-wide presence
(`ONLINE`/`OFFLINE` transitions, and not flipping a user offline just because
*one* of their tabs disconnected while another is open on a different replica)
is tracked the same way, via short-lived per-connection Redis keys refreshed on
the existing 30s heartbeat - a replica that crashes outright simply stops
refreshing its keys, and they expire on their own rather than leaving someone
stuck "online" forever.

Without `REDIS_URL` set, none of this changes - every replica behaves exactly
as it did before Redis support existed, and a single-replica deployment never
touches Redis at all. See `server/src/ws/presenceFanout.ts` for the mechanism
and `server/test/integration/presenceFanout.test.ts` for tests that prove one
publish reaches multiple independent subscriber connections (standing in for
multiple replicas).

## Testing

```bash
npm run test --workspace server          # unit tests - pure logic, no database
npm run test --workspace client          # client unit/component tests
npm run test:integration --workspace server   # full API + federation tests, real database
```

**Unit tests** (`server/src/**/*.test.ts`, `client/src/**/*.test.ts`) cover pure logic
with no I/O: ULID/identity parsing, Ed25519 request signing and verification,
permission bitmasks, user serialization (including the INVISIBLE-status-visibility
rule below), and the client's token-refresh and WebSocket-reconnect logic.

**Integration tests** (`server/test/integration/*.test.ts`) run the real Express app
(via `supertest`) against a real Postgres database, covering auth, friends, DMs,
presence, and the federation protocol's security checks (signature verification,
timestamp expiry, sender-domain spoofing, conversation-membership checks) end to end.
Several are regression tests written directly against bugs found during this
project's manual testing history - each has a comment explaining the original bug and
why the test would have caught it; see in particular
`conversations.test.ts` (message cross-contamination between a DM and a channel),
`federation.test.ts` (remote stub `protocolId` consistency), and `presence.test.ts`
(presence broadcasts using `protocolId`, never the local database id).
`presenceFanout.test.ts` is different in kind - not a regression test, but a proof
that Redis pub/sub actually delivers one publish to multiple independent subscriber
connections, which is the whole mechanism [Running multiple
replicas](#running-multiple-replicas) above depends on; it needs a real Redis (see
below) and is the one file in this suite that doesn't run with Redis unset.

To run the integration suite locally, you need a disposable `chat_test` database on
the same Postgres container `scripts/start.ps1` already manages, and Redis running
(for `presenceFanout.test.ts` only - everything else in the suite ignores it):

```bash
docker compose up -d postgres redis
docker exec my-chat-app-postgres-1 psql -U chat -d chat -c "CREATE DATABASE chat_test"
cd server && DATABASE_URL="postgresql://chat:chat@localhost:5433/chat_test" npx prisma migrate deploy
npm run test:integration --workspace server
```

`server/test/setupEnv.ts` fills in the rest of the required env vars (JWT secrets,
`SERVER_DOMAIN`, etc.) with test-only defaults if they aren't already set, so no
`.env.test` file is required. Every test file resets the database to empty between
tests (`server/test/helpers/db.ts`), so the suite is safe to run repeatedly and in
any order.

### Coverage

```bash
npm run test:coverage --workspace server             # unit suite, informational only
npm run test:coverage --workspace client              # informational only
npm run test:integration:coverage --workspace server  # the enforced gate - see below
```

Each produces a `coverage/` directory (text summary + `lcov` + a browsable `html`
report) in that workspace. The **integration** suite is the meaningful number, since
it's the one that actually exercises route handlers rather than just pure library
code - it has enforced thresholds in `server/vitest.integration.config.ts`
(statements/branches/functions/lines), set a few points below the measured baseline
as a regression floor rather than a stretch target: a CI failure here means a real,
sizable drop (e.g. a new route file shipped with no tests), not normal fluctuation.
Raise the thresholds over time as coverage genuinely improves. The unit and client
suites report coverage too but don't enforce it - they're intentionally narrow in
scope (pure logic / two specific regression areas), so a hard threshold there would
be more theater than signal.

> **Note**: collecting coverage forks a fresh worker process per test file, and this
> was observed to occasionally crash outright on Windows (`STATUS_ACCESS_VIOLATION`,
> unrelated to any specific test's content) during development - `singleFork: true`
> reduces but didn't fully eliminate it locally. This is a Windows/V8-coverage
> interaction, not expected on the Linux CI runners; if the integration-tests job
> ever shows a bare "Worker exited unexpectedly" failure with no actual test
> assertion failure, it's this, not a real regression - re-run the job.

### CI pipeline

`.github/workflows/ci.yml` runs on every push and pull request against `master`:

- **lint** - `oxlint` on the client.
- **typecheck-and-build** - both workspaces' production build scripts (`tsc`/`tsc -b
  && vite build`), plus a separate typecheck of the server's `test/` directory (its
  production build intentionally excludes tests from `dist/`, so this is the only
  place that directory's types are checked).
- **unit-tests** - both workspaces' unit suites (with informational coverage,
  uploaded as a build artifact), no database.
- **integration-tests** - the server's integration suite against real `postgres:16`
  and `redis:7` service containers (the latter only exercised by
  `presenceFanout.test.ts` - every other test in the suite still runs with Redis
  unset), enforcing the coverage floor described above (also uploaded as an
  artifact).
- **dependency-audit** - `npm audit --audit-level=high` across the whole workspace.
- **dependency-review** - flags newly introduced vulnerable/license-problematic
  dependencies in a pull request's diff.
- **secret-scan** - [gitleaks](https://github.com/gitleaks/gitleaks) over each pull
  request's new commits (its default behavior on `pull_request` events - it diffs
  against the PR's base, not the whole repo, regardless of checkout depth). The
  repo's pre-existing history was separately confirmed clean with one manual
  full-history run before this pipeline existed; every commit added from here on is
  covered exactly once, at the PR that introduces it.
- **codeql** - GitHub's static analysis (SAST) for JavaScript/TypeScript.

## What's implemented (MVP)

- **Identity**: `@username:domain` identities (domain is this server's configured
  `SERVER_DOMAIN`), registration, login, JWT access/refresh tokens with rotation.
- **Friends**: requests (send/accept/decline/cancel), friendships, blocking.
- **Presence**: online/away/busy/DND/invisible/offline + custom status, pushed live to
  friends over WebSocket.
- **Messaging**: 1:1 and group DMs, community text channels, replies, edits, deletes,
  reactions, file/image attachments, typing indicators.
- **Communities**: creation, join (open or by ID), roles with a permission bitmask,
  channels, kick/ban, basic moderation.
- **Emoticons**: personal + community emoticons, custom `:trigger:` syntax rendered
  inline in messages, saving other users' emoticons, forking with parent provenance.
- **Offline delivery**: every mutation that matters to a user is appended to a
  per-recipient `SyncEvent` outbox; the client replays `GET /api/v1/sync?cursor=...`
  on reconnect before trusting live WebSocket events, so messages/requests sent while
  you were offline still arrive.
- **Server discovery**: `GET /.well-known/communication-platform` advertises protocol
  version, feature flags, API/WebSocket endpoints, and (for federation) the server's
  Ed25519 public key.
- **Federation**: two independently-run homeservers can discover each other, and their
  users can send/accept federated friend requests, exchange 1:1 DMs, and see each
  other's presence update live — all over a signed HTTP protocol
  (`/federation/v1/*`). See [Federation demo](#federation-demo-two-servers-talking-to-each-other)
  above and [Architecture notes](#architecture-notes--federation) below.

## What's not here yet

Per the spec's phased plan, these are intentionally deferred (see
[ROADMAP.md](ROADMAP.md) for the fuller list, including client apps and
infrastructure work beyond the protocol itself):

- **Federated communities and group DMs** — federation in this phase covers
  discovery, friends, 1:1 DMs, and presence only (see [Known federation
  limitations](#known-federation-limitations)).
- **Remote edit/delete/reactions** — a message edit, delete, or reaction doesn't
  propagate to the other server once the message itself has been relayed.
- **Voice** (WebRTC community/DM calls).
- **End-to-end encryption**.
- **Community migration between hosts**, a public community directory, invite codes
  (joining today is either open by community ID or via the in-app "copy ID" button).
- A formal, versioned federation protocol **specification** document (`protocol/`).

## Architecture notes — federation

A few foundational decisions in `server/prisma/schema.prisma` and `server/src/` are
what let federation get layered in without re-architecting the single-server code:

- Every federatable object (`User`, `Message`, `Conversation`, `Community`, `Channel`,
  `Emoticon`, `SyncEvent`, ...) has a `protocolId` (ULID) **separate from its local
  database id**. Local ids never leak into API responses — only `protocolId`. Two
  servers that both know about the same message/conversation/person agree on its
  `protocolId`, even though each stores it under its own local database id.
- Identity is always `@username:domain`, computed from a configurable `SERVER_DOMAIN`,
  never hardcoded to "the official server."
- `SyncEvent` is a per-recipient outbox with cursor-based resumable sync
  (`GET /api/v1/sync?cursor=`) — the client's own reconnect path, and conceptually the
  same shape a federation inbox needs.
- `GET /.well-known/communication-platform` is real server discovery: it carries the
  server's federation API base and Ed25519 public key.
- Friendships, DMs, and community membership are modeled as independent concerns (per
  Rules 2–4 in the spec) — nothing assumes same-server membership.

**How the federation protocol actually works** (`server/src/lib/federation/`,
`server/src/modules/federation/`):

- Each homeserver generates an Ed25519 keypair on first boot (`ServerIdentity` table)
  and publishes the public half via `.well-known`.
- `resolvePeer(domain)` fetches (and caches, `FederationPeer` table, 10 min TTL) a
  peer's `.well-known` document the first time it's needed — or, in local dev, reads
  the `FEDERATION_PEER_OVERRIDES` JSON env var instead, since `alice.test`/`bob.test`
  aren't real DNS names.
- Every outbound federation request is signed (`signRequest`): the canonical string
  `METHOD\nPATH\nTIMESTAMP\nSHA256(body)` is Ed25519-signed and sent as
  `X-Federation-Origin` / `X-Federation-Timestamp` / `X-Federation-Signature` headers.
  The receiving server's `requireFederationAuth` middleware resolves the claimed
  origin's public key and verifies the signature before any `/federation/v1/*` route
  runs, rejecting timestamps outside a ±5 minute window.
- A remote person is represented locally as a **cached stub User row**
  (`User.isRemote = true`, `User.homeserverDomain`, nullable `passwordHash`) carrying
  their *real* `protocolId` from their home server — not a locally-generated one, since
  the client matches live WebSocket events by `protocolId` and the two servers must
  agree on it. Because this stub is a completely ordinary `User` row, every existing
  table that references a user (`FriendRequest`, `Friendship`, `ConversationMember`,
  `Message.sender`) handles a remote person through the exact same foreign key it
  already used for a local one — no schema changes needed anywhere else, and the
  client renders federated data through the exact same `PublicUser`/`Message` shapes.
- Friend requests, DM conversation creation, message sends, and presence changes each
  have a thin "if any party is remote, also call their `/federation/v1/*` inbox"
  branch added to their existing local route handler (see
  `server/src/modules/friends/routes.ts`, `conversations/routes.ts`,
  `presence/presenceStore.ts`) — the local DB write always happens first and always
  succeeds even if the federation call then fails.

## Known federation limitations

Honest, deliberate cuts for this phase — not bugs:

- **No durable outbox/retry queue.** `federationFetch` retries a failed call a handful
  of times with backoff and then gives up; there's no backfill once an unreachable
  peer comes back. The [restart-resilience check](#federation-demo-two-servers-talking-to-each-other)
  above demonstrates exactly this: a message sent while the recipient's server is down
  is simply lost, while the sender's own server stays fully healthy throughout.
- **Replay protection is a timestamp window only** (±5 minutes) — no nonce cache, so a
  captured signed request could in principle be replayed within that window.
- **Remote message edits, deletes, and reactions don't propagate** — only the initial
  send is relayed.
- **No group DMs or communities across servers** — federation covers 1:1 DMs only.
- **Blocking a remote user is local-only** — it stops delivery on your side but doesn't
  notify their server, consistent with blocking being a privacy control rather than a
  negotiated state.

## Known simplifications (for an honest MVP, not hidden)

- Communities are "open join" by ID today — no invite codes or private/discoverable
  distinction yet.
- No automated end-to-end tests for federation scenarios — verified manually via the
  two-server demo above (see also `scripts/start-federation-demo.ps1`).
- No rate limiting, 2FA, or admin web UI yet (JWT auth, bcrypt hashing, and file-type/
  size-limited uploads are in place as a baseline).
- File storage is local filesystem only (`server/uploads/`); the spec's S3-compatible
  storage abstraction isn't built yet.
