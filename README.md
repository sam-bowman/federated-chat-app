# My Chat App

An MVP of a federated, open-source communication platform — Discord-style communities
and channels, MSN-style friends/presence/DMs, and user-created emoticons — built as a
single self-hosted homeserver for now, with a **federation-ready data and protocol
design** (see [Architecture notes](#architecture-notes--whats-federation-ready) below).

This is Phase 1+2 (and a slice of Phase 3/4) of the platform described in the
[product spec](docs/spec.md): identity, a homeserver, friends, presence, 1:1/group
DMs, communities with channels and roles, and custom emoticons with saving/forking.
Real server-to-server federation, voice, and E2EE are **not** implemented yet — see
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
  version, feature flags, and API/WebSocket endpoints.

## What's not here yet

Per the spec's phased plan, these are intentionally deferred:

- **Real federation** — multiple independently-run homeservers talking to each other.
  The identity format, protocol versioning, event model, and ULID-based protocol IDs
  (kept separate from local DB IDs) are all already in place to support this without a
  rewrite, but the actual server-to-server auth/sync/discovery protocol isn't built.
- **Voice** (WebRTC community/DM calls).
- **End-to-end encryption**.
- **Community migration between hosts**, a public community directory, invite codes
  (joining today is either open by community ID or via the in-app "copy ID" button).
- A formal, versioned federation protocol **specification** document (`protocol/`).

## Architecture notes — what's "federation-ready"

Even though this MVP is single-server, a few decisions in `server/prisma/schema.prisma`
and `server/src/` are there specifically so federation can be layered in later without
re-architecting:

- Every federatable object (`User`, `Message`, `Conversation`, `Community`, `Channel`,
  `Emoticon`, `SyncEvent`, ...) has a `protocolId` (ULID) **separate from its local
  database id**. Local ids never leak into API responses — only `protocolId`.
- Identity is always `@username:domain`, computed from a configurable `SERVER_DOMAIN`,
  never hardcoded to "the official server."
- `SyncEvent` is a per-recipient outbox with cursor-based resumable sync
  (`GET /api/v1/sync?cursor=`), the same shape a federation peer's inbox would need.
- `GET /.well-known/communication-platform` is the seed of real server discovery.
- Friendships, DMs, and community membership are modeled as independent concerns (per
  Rules 2–4 in the spec) — nothing assumes same-server membership.

## Known simplifications (for an honest MVP, not hidden)

- Communities are "open join" by ID today — no invite codes or private/discoverable
  distinction yet.
- No end-to-end tests for federation scenarios (there's only one server).
- No rate limiting, 2FA, or admin web UI yet (JWT auth, bcrypt hashing, and file-type/
  size-limited uploads are in place as a baseline).
- File storage is local filesystem only (`server/uploads/`); the spec's S3-compatible
  storage abstraction isn't built yet.
