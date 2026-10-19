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
other and let their users friend, DM (1:1 and group), join each other's communities,
and see each other's live presence across the server boundary, over a signed HTTP
protocol (see [Architecture notes](docs/federation-architecture.md#architecture-notes--federation)).

This is Phase 1+2 (and a slice of Phase 3/4) of the platform described in the
[product spec](docs/spec.md): identity, a homeserver, friends, presence, 1:1/group
DMs, communities with channels and roles, custom emoticons with saving/forking, and
federated discovery/friends/DMs (1:1 and group)/communities/presence between
homeservers. Voice and E2EE are **not** implemented yet — see
[What's not here yet](#whats-not-here-yet).

## Stack

- **Server**: Node.js + TypeScript, Express, `ws` (WebSockets), Prisma + PostgreSQL, JWT auth.
- **Client**: React + TypeScript + Vite, React Router.
- **Dev infra**: Docker Compose (PostgreSQL only — the app itself runs natively for fast iteration).

## Project layout

```text
server/   Express API + WebSocket gateway + Prisma schema/migrations
client/   React web client (Vite)
docker-compose.yml            PostgreSQL (+ optional Redis) for local dev
docker-compose.selfhost.yml   Server + client + Postgres for self-hosting (see [docs/deployment/docker.md](docs/deployment/docker.md))
```

## Documentation

| I want to... | Read |
|---|---|
| Use the app | [docs/client-guide.md](docs/client-guide.md) |
| Choose a deployment method | [docs/deployment/README.md](docs/deployment/README.md) |
| Run it locally for development | [docs/deployment/local-development.md](docs/deployment/local-development.md) |
| Run it with Docker or Docker Compose | [docs/deployment/docker.md](docs/deployment/docker.md) |
| Upgrade, back up, or restore a deployment | [docs/deployment/upgrading-and-backups.md](docs/deployment/upgrading-and-backups.md) |
| Deploy to Kubernetes (Helm) | [docs/deployment/kubernetes.md](docs/deployment/kubernetes.md) |
| Run the native server/client binaries | [docs/deployment/native-binaries.md](docs/deployment/native-binaries.md) |
| Install the desktop app | [docs/deployment/desktop-app.md](docs/deployment/desktop-app.md) |
| Make a server private, or limit which servers it talks to | [docs/deployment/private-server.md](docs/deployment/private-server.md) |
| Let only people you invite make an account | [docs/deployment/invite-only.md](docs/deployment/invite-only.md) |
| See every way it's packaged | [docs/distribution.md](docs/distribution.md) |
| Run more than one replica, or store uploads in S3 | [docs/scaling.md](docs/scaling.md) |
| Understand rate limiting, the password policy, and 2FA | [docs/security.md](docs/security.md) |
| Try federation locally with two servers | [docs/federation-demo.md](docs/federation-demo.md) |
| Understand how federation is built, and its limits | [docs/federation-architecture.md](docs/federation-architecture.md) |
| Implement a compatible homeserver | [protocol/federation.md](protocol/federation.md) |
| Run or write tests | [docs/testing.md](docs/testing.md) |
| Contribute | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Understand releases and versioning | [docs/versioning.md](docs/versioning.md) |
| Read the product spec | [docs/spec.md](docs/spec.md) |

## Getting started

### The easy way: start/stop scripts

```powershell
.\scripts\start.ps1   # brings up Postgres (Docker), the server, and the client
.\scripts\stop.ps1    # shuts everything down (your data is kept in a Docker volume)
```

`start.ps1` launches Docker Desktop if it isn't running, starts Postgres, creates
`server/.env` and `client/.env` from their `.env.example` files the first time, runs
`npm install` if needed, generates the Prisma client if it's missing, applies Prisma
migrations, and starts the server (`http://localhost:4000`) and client
(`http://localhost:5173`) as background processes — logs land in `.run\server.log` /
`.run\client.log`. It only reports success once the server answers `/healthz` and the client
serves its page, and it's safe to re-run (it leaves a copy of the app that's already
running alone, and stops with an error if a different program holds one of its ports).

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
and realtime delivery between two accounts. See
[docs/client-guide.md](docs/client-guide.md) for a full walkthrough of what you can
do as a user — friends, DMs, communities, emoticons, 2FA.

### Logging into a different server (home-server picker)

The client above is in "fixed-server mode" because `client/.env` sets
`VITE_API_URL` — every build/deployment that sets it (including the Docker
image by default) only ever talks to that one server. Unset it and the
client has no default server at all: it shows a "Find your server" step
before login, where typing an identity (`@you:chat.example.com`) or just a
server's address resolves it via `.well-known` and remembers which server a
saved session belongs to. This is what unlocks a desktop app, mobile apps,
and a multi-tenant web deployment without any of them needing their own
server-selection logic — see [docs/distribution.md](docs/distribution.md).

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
  version, feature flags, API/WebSocket endpoints, and (for federation) the server's
  Ed25519 public key.
- **Federation**: two independently-run homeservers can discover each other, and their
  users can send/accept federated friend requests, exchange 1:1 DMs, and see each
  other's presence update live — all over a signed HTTP protocol
  (`/federation/v1/*`). See [Federation demo](docs/federation-demo.md)
  and [Architecture notes](docs/federation-architecture.md#architecture-notes--federation).

## What's not here yet

Per the spec's phased plan, these are intentionally deferred. Planned work
is tracked as [GitHub issues](https://github.com/sam-bowman/federated-chat-app/issues)
(label `enhancement`), including client apps and infrastructure work beyond
the protocol itself; what's already shipped is in [CHANGELOG.md](CHANGELOG.md):

- **A federated community's remote members can't exercise management
  permissions remotely** — kicking, banning, managing roles, or creating
  channels as a remote member isn't supported; the home server's own owner
  can already do all of this locally against a cached remote member, with
  no new code needed (see
  [`protocol/federation.md`](protocol/federation.md#communities)).
- **Voice** (WebRTC community/DM calls).
- **End-to-end encryption**.
- **Community migration between hosts**, a public community directory, invite codes
  (joining today is either open by community ID or via the in-app "copy ID" button).

## Known simplifications (for an honest MVP, not hidden)

- Communities are "open join" by ID today — no invite codes or private/discoverable
  distinction yet.
- No automated end-to-end tests for federation scenarios — verified manually via the
  two-server demo ([docs/federation-demo.md](docs/federation-demo.md); see also `scripts/start-federation-demo.ps1`).
- No admin web UI yet (JWT auth, bcrypt hashing, rate limiting, 2FA, password breach
  checks, and file-type/size-limited uploads are in place as a baseline).
- File storage defaults to the local filesystem (`server/uploads/`), correct for a
  single replica; an S3-compatible storage driver is available (`STORAGE_DRIVER=s3`
  - see [docs/scaling.md](docs/scaling.md)) for more than one.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR workflow, testing/doc
expectations, and what CI actually enforces. Releases follow
[docs/versioning.md](docs/versioning.md) (semver, lockstep across the repo) and are tracked
in [CHANGELOG.md](CHANGELOG.md). Licensed under [MIT](LICENSE).
