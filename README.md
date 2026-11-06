# My Chat App

[![CI](https://github.com/sam-bowman/federated-chat-app/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/sam-bowman/federated-chat-app/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/sam-bowman/federated-chat-app)](https://github.com/sam-bowman/federated-chat-app/commits/master)
[![Open issues](https://img.shields.io/github/issues/sam-bowman/federated-chat-app)](https://github.com/sam-bowman/federated-chat-app/issues)
[![Node.js](https://img.shields.io/badge/node-22-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](server/tsconfig.json)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](client/package.json)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?logo=postgresql&logoColor=white)](docker-compose.yml)

A federated, open-source communication platform: communities with channels and roles,
persistent friends, presence and private messages, voice, bots, and user-created
emoticons — with real **server-to-server federation**: independently-run homeservers
can discover each other and let their users friend, DM (1:1 and group), join each
other's communities, and see each other's live presence across the server boundary,
over a signed HTTP protocol (see
[Architecture notes](docs/federation-architecture.md#architecture-notes--federation)).

It is built in the open to the [product spec](docs/spec.md) and ships as a Docker image,
a Helm chart, native binaries and a desktop app. What is built is listed under
[Features](#features); what is planned next is under [Roadmap](#roadmap). End-to-end
encryption and federated voice are not implemented yet.

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
| Add voice channels (LiveKit, and two ports to forward) | [docs/deployment/voice.md](docs/deployment/voice.md) |
| Understand reports, who reviews them and how long they are kept | [docs/content-reports.md](docs/content-reports.md) |
| See every way it's packaged | [docs/distribution.md](docs/distribution.md) |
| Run more than one replica, or store uploads in S3 | [docs/scaling.md](docs/scaling.md) |
| Understand rate limiting, the password policy, and 2FA | [docs/security.md](docs/security.md) |
| See what the server trusts and what it defends against | [docs/threat-model.md](docs/threat-model.md) |
| Report a vulnerability | [SECURITY.md](SECURITY.md) |
| Try federation locally with two servers | [docs/federation-demo.md](docs/federation-demo.md) |
| Understand how federation is built, and its limits | [docs/federation-architecture.md](docs/federation-architecture.md) |
| Write a bot (accounts for programs, tokens, the WebSocket, an example) | [docs/bots.md](docs/bots.md) |
| Post to a channel from a script (incoming webhooks) | [docs/webhooks.md](docs/webhooks.md) |
| Write a client or script against the REST API | [docs/api/reference.md](docs/api/reference.md) (OpenAPI: [docs/api/openapi.yaml](docs/api/openapi.yaml)) |
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

> **Note on multiple accounts**: a browser (or the desktop app) can be signed in to
> several accounts at once, on one server or on different ones. Each account's tokens
> are kept separately in `localStorage`, and each **tab** follows its own account, so
> two tabs can be two different people. Use the **Accounts** button at the bottom of
> the sidebar to switch, sign one out, or add another. Only the account in use is
> connected (the others raise no alerts until you switch to them).

## Features

- **Identity**: `@username:domain` identities (domain is this server's configured
  `SERVER_DOMAIN`), registration (open, or by invitation only), login, JWT access/refresh
  tokens with rotation, optional two-factor authentication, several accounts per device,
  and account export and deletion.
- **Friends and privacy**: requests (send/accept/decline/cancel), friendships, blocking,
  and per-person choices about who can find you and who can start a conversation with you.
- **Presence**: online/away/busy/do-not-disturb/invisible/offline + custom status, pushed
  live to friends over WebSocket, including across servers.
- **Messaging**: 1:1 and group DMs, community text channels, replies, edits, deletes,
  reactions (emoji and custom emoticons), file and image attachments, link previews,
  community invitations, typing indicators, and sound and desktop notifications.
- **Communities**: creation, joining by ID or invite code, roles with a permission
  bitmask, channels, kick/ban, an audit log, content reports with a review queue, a
  public directory, and visibility settings (public, unlisted, invite-only, local-only).
- **Voice**: voice channels and calls in direct conversations over a LiveKit SFU, with
  per-person volume, device choice and a call quality readout.
- **Emoticons**: personal + community emoticons, custom `:trigger:` syntax rendered
  inline in messages, saving other users' emoticons, forking with parent provenance.
- **Bots and integrations**: bot accounts with tokens, cards (embeds) with pictures,
  slash commands with options forms, and incoming webhooks. See [docs/bots.md](docs/bots.md)
  and [docs/webhooks.md](docs/webhooks.md).
- **Offline delivery**: every mutation that matters to a user is appended to a
  per-recipient `SyncEvent` outbox; the client replays `GET /api/v1/sync?cursor=...`
  on reconnect before trusting live WebSocket events, so messages/requests sent while
  you were offline still arrive.
- **Server discovery**: `GET /.well-known/communication-platform` advertises protocol
  version, feature flags, API/WebSocket endpoints, and (for federation) the server's
  Ed25519 public key.
- **Federation**: independently-run homeservers discover each other, and their users can
  send/accept federated friend requests, exchange 1:1 and group DMs, join each other's
  communities and see each other's presence update live — all over a signed HTTP protocol
  (`/federation/v1/*`) with a durable retry queue. A server can be made private or limited to
  chosen peers. See [Federation demo](docs/federation-demo.md) and
  [Architecture notes](docs/federation-architecture.md#architecture-notes--federation).
- **Operating it**: an admin page and command line, a server settings page, rate limiting,
  password breach checks, S3-compatible upload storage, multiple replicas behind Redis,
  and dependency, image and secret scanning in CI. See the [documentation](#documentation) table.
- **Clients**: a web client, a desktop app that updates itself, and a layout for phones.

## Roadmap

Planned work is tracked as [GitHub issues](https://github.com/sam-bowman/federated-chat-app/issues)
(label `enhancement`); what has shipped is in [CHANGELOG.md](CHANGELOG.md). The main items:

- **End-to-end encryption** for private conversations, with key and device management.
- **Federated voice**: calls and voice channels that include people on other servers.
- **Remote management**: letting a member of a community hosted elsewhere exercise management
  permissions (kick, ban, roles, channels); today only the community's home server can.
- **Bots, further**: buttons and select menus on a bot's messages ([plan](docs/commands-3c-plan.md)),
  running commands and pressing buttons from other servers, bots in communities hosted elsewhere,
  outgoing webhooks, and a bot directory.
- **Push notifications** to a closed app, and mobile apps.
- **Community migration** between hosts.
- **Wider webhook support**: attachments, and request formats used by other tools.

## Current limitations

- Notifications are raised while the app is running; there is no push to a closed app yet.
- Uploads default to the local filesystem (`server/uploads/`), correct for a single
  replica; an S3-compatible driver (`STORAGE_DRIVER=s3`, see [docs/scaling.md](docs/scaling.md))
  is needed for more than one.
- People on other servers can read a community's messages and take part in it, but cannot yet run
  its bots' commands, and cannot manage it (see the roadmap).
- Federation limits are listed in
  [Known federation limitations](docs/federation-architecture.md#known-federation-limitations).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR workflow, testing/doc
expectations, and what CI actually enforces. Releases follow
[docs/versioning.md](docs/versioning.md) (semver, lockstep across the repo) and are tracked
in [CHANGELOG.md](CHANGELOG.md). Licensed under [MIT](LICENSE).
