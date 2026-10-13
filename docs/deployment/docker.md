# Docker and Docker Compose

> Part of the [documentation](../../README.md#documentation) and the
> [deployment guides](README.md).

The recommended way to self-host. Every tagged release publishes multi-stage,
non-root, multi-arch (`linux/amd64` + `linux/arm64`) images to GHCR - see
[distribution.md](../distribution.md) for the full packaging matrix:

```bash
docker pull ghcr.io/sam-bowman/federated-chat-app-server:latest
docker pull ghcr.io/sam-bowman/federated-chat-app-client:latest
```

Also tagged by exact version (`:0.8.0`) and minor (`:0.8`) - see
`.github/workflows/publish-images.yml`.

Everything in this guide was run against the published images, apart from what
is explicitly marked **not tested**.

## Quick start

```bash
cp .env.selfhost.example .env.selfhost
# edit .env.selfhost - see "Configuration" below
docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost up -d
```

This is distinct from the plain `docker-compose.yml` at the repo root, which is
dev-only (Postgres/Redis for `npm run dev`; the app itself runs natively there).

Then open `CLIENT_PUBLIC_URL`, register, and you have an account. The first
start applies all database migrations automatically.

**What it doesn't set up**: TLS and a single public port. Both services publish
a plain-HTTP host port. The client's `API_URL` is fetched by the *browser*, not
proxied through nginx, so both `CLIENT_PUBLIC_URL` and `SERVER_PUBLIC_URL` must
be real, externally-reachable addresses - put a reverse proxy (nginx, Caddy,
Traefik) in front of both yourself. See the `trust proxy` caveat under "Rate
limiting" in [security.md](../security.md#rate-limiting) if you do.

## Configuration

`.env.selfhost.example` documents every variable. The ones people get wrong:

| Variable | What it must be |
|---|---|
| `SERVER_DOMAIN` | The domain you'll be known as. Becomes part of every user id (`@user:domain`); **cannot be changed later** without breaking existing users. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Long random strings, different from each other (`openssl rand -base64 32`). |
| `POSTGRES_PASSWORD` | Any password; used for both Postgres and the server's `DATABASE_URL`. Postgres is not published to the host. |
| `CLIENT_PUBLIC_URL` | Exactly what's in the browser's address bar for the web client: scheme + host + port, no path, no trailing slash. Becomes the server's `CORS_ORIGIN`, which accepts **one** origin only. |
| `SERVER_PUBLIC_URL` | The server's externally-reachable origin. Becomes `PUBLIC_BASE_URL` and the client's `API_URL`. |
| `IMAGE_TAG` | Pin an exact version (`0.8.0`); `latest` means a `pull` can upgrade you without you choosing to. |
| `SERVER_PORT`, `CLIENT_PORT` | Host ports (defaults 4000 / 8080). Change if taken. |

Other server settings (`MAX_UPLOAD_BYTES`, rate limits, S3 storage, ...) are
listed in `server/.env.example`; add them under the server's `environment:` in
the compose file exactly as shown there.

Fixed server vs. server picker: the compose file points the client at your one
server. To let visitors type in any server's address instead, change the
client's `API_URL: "${SERVER_PUBLIC_URL}"` line to `API_URL: ""` - see
"Logging into a different server" in the README.

Redis (only for several server replicas) is behind `--profile multi-replica`;
see [Running multiple replicas](../scaling.md#running-multiple-replicas).

## Running the images directly

Equivalent to what the compose file wires together, if you'd rather run or
orchestrate the containers yourself:

```bash
docker run -d --name chat-server \
  -e SERVER_DOMAIN=chat.example.com \
  -e DATABASE_URL=postgresql://chat:chat@postgres-host:5432/chat \
  -e JWT_ACCESS_SECRET=<a long random string> \
  -e JWT_REFRESH_SECRET=<a different long random string> \
  -e CORS_ORIGIN=https://chat.example.com \
  -p 4000:4000 \
  -v chat-uploads:/app/uploads \
  ghcr.io/sam-bowman/federated-chat-app-server:latest

docker run -d --name chat-client \
  -e API_URL=https://api.chat.example.com \
  -p 8080:8080 \
  ghcr.io/sam-bowman/federated-chat-app-client:latest
```

> **Set `SERVER_DOMAIN`, both JWT secrets and `PUBLIC_BASE_URL`.** Unlike the compose
> file, a bare `docker run` does not make anything required by itself. In releases up
> to and including `0.9.0`, leaving out the JWT secrets started the server with
> built-in, **publicly known** development secrets (anyone could forge login tokens),
> and leaving out `SERVER_DOMAIN` started it as `localhost`, with no warning
> ([#77](https://github.com/sam-bowman/federated-chat-app/issues/77)). Newer releases
> refuse to start the image in that state (`NODE_ENV=production` is set in it) and
> list what is missing; set `ALLOW_INSECURE_DEFAULTS=true` only for a throwaway local
> trial. An *explicit* `SERVER_DOMAIN=localhost` is accepted.

**`server/Dockerfile`** runs `prisma migrate deploy` on every container start,
then the app. **`client/Dockerfile`** serves the build with nginx and generates
a small `env-config.js` from the `API_URL` env var at container start
(`client/docker-entrypoint.sh`), so one built image can point at any server.

Both Dockerfiles build from the **repo root** as context (`docker build -f
server/Dockerfile .`), not their own directory - the root `package-lock.json` is
needed for a correct `npm ci`.

## Upgrading

Shared with the other deployments - read [upgrading-and-backups.md](upgrading-and-backups.md)
first, in particular [why re-tagging is not a rollback](upgrading-and-backups.md#why-re-tagging-is-not-a-rollback)
and [the `localhost` backfill](upgrading-and-backups.md#the-localhost-backfill).
For this setup:

```bash
# 1. back up first (see below)
# 2. edit IMAGE_TAG in .env.selfhost, then:
docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost pull
docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost up -d
```

Verified: `0.7.0` -> `0.8.0` with users, a community, a message and an upload
present; all of it survived and the migrations applied on the server's start.

## Backing up and restoring

The exact commands, with what is and isn't included (the database dump contains
the server's federation private key), are in
[upgrading-and-backups.md](upgrading-and-backups.md#backing-up). The restore
procedure there is also the rollback procedure. The default Compose project name
for `docker-compose.selfhost.yml` is `federated-chat-app-selfhost`, so the
Postgres container is `federated-chat-app-selfhost-postgres-1` and the volumes are
`federated-chat-app-selfhost_postgres-data` / `..._uploads-data`.

## Troubleshooting

Messages below are copied from real runs.

### `docker compose up` stops immediately naming a variable

```
required variable SERVER_DOMAIN is missing a value: Set SERVER_DOMAIN in .env.selfhost - ...
```

Each of `SERVER_DOMAIN`, `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, `CLIENT_PUBLIC_URL`, `SERVER_PUBLIC_URL` fails the same
way, before any container starts. Fill it in. If you set it and still see this,
you probably forgot `--env-file .env.selfhost`.

### `Bind for 0.0.0.0:<port> failed: port is already allocated`

```
Error response from daemon: failed to set up container networking: ...
Bind for 0.0.0.0:14100 failed: port is already allocated
```

Something else owns the host port. Change `SERVER_PORT` / `CLIENT_PORT` in
`.env.selfhost` (and keep `SERVER_PUBLIC_URL` / `CLIENT_PUBLIC_URL` in step).
The other containers of the stack were already started when this appeared, so
`down` before retrying.

### The page loads but every request fails (CORS)

In the browser console:

```
Access to fetch at 'http://localhost:14000/api/v1/auth/login' from origin
'http://127.0.0.1:18080' has been blocked by CORS policy: The
'Access-Control-Allow-Origin' header has a value 'http://localhost:18080' that
is not equal to the supplied origin.
```

The server allows exactly one origin (`CLIENT_PUBLIC_URL`), compared as a string.
`localhost` and `127.0.0.1` are different origins; so are `http` vs `https` and
`:8080` vs none. Open the client at exactly `CLIENT_PUBLIC_URL`, or change that
value. `curl` will not show the problem - it doesn't enforce CORS. A second web
origin (or the [desktop app](desktop-app.md)) cannot be allowed at the same time
today; that's tracked in [#79](https://github.com/sam-bowman/federated-chat-app/issues/79).

### `P1000: Authentication failed against database server`

The server's `migrate deploy` could not log in. With the bundled Postgres this
means `POSTGRES_PASSWORD` differs from what the data volume was **first created**
with - Postgres only reads that variable when initialising an empty volume, so
changing it later does not change the password. Either put the old value back
or, if the data is disposable, `down -v`.

### `P1001: Can't reach database server at ...`

The host in `DATABASE_URL` is wrong or Postgres isn't up. With the compose file
the host is `postgres` and the server waits for Postgres to be healthy, so this
usually means you're running the server image yourself with a bad
`DATABASE_URL`.

### A wrong database *name* does not fail

Pointing `DATABASE_URL` at a database that doesn't exist does not error: the
migration step **creates** an empty one and the server starts normally, looking
like all your data vanished. If a restart suddenly shows an empty instance,
check the name in `DATABASE_URL` before anything else. (Tracked in [#80](https://github.com/sam-bowman/federated-chat-app/issues/80).)

### The server container exits at once with "Refusing to start"
Releases after `0.9.0` check two things before listening and say which one failed:

- `Refusing to start: this looks like a deployment ... but the server is not configured
  safely` - followed by the missing or placeholder `JWT_ACCESS_SECRET`,
  `JWT_REFRESH_SECRET` or `SERVER_DOMAIN`. Set them
  ([#77](https://github.com/sam-bowman/federated-chat-app/issues/77)).
- `Refusing to start: the database has N migration(s) this version does not know about` -
  the database was migrated by a newer version than the image you started. Upgrade, or
  [restore a backup](upgrading-and-backups.md#why-re-tagging-is-not-a-rollback)
  ([#83](https://github.com/sam-bowman/federated-chat-app/issues/83)).

Under `restart: unless-stopped` it keeps retrying and logging the same message, which is
the intended signal; on Kubernetes the new pod stays `CrashLoopBackOff` while an older pod
keeps serving.

### The server container keeps restarting

`restart: unless-stopped` hides crash loops. Read `docker compose logs server`.
The two causes seen: a failed migration (above), and - in releases up to and
including `0.9.0` - an unhandled error in an async route handler, which exited the
whole process (Express 4 doesn't catch rejected promises;
[#76](https://github.com/sam-bowman/federated-chat-app/issues/76)). The restart policy
brought it back, so one bad request looked like a brief outage. Newer releases answer
that request with `{"error":"internal_error"}` (HTTP 500), keep serving, and log
`[http] <METHOD> <URL> failed:` with the error - search the logs for that.

### After an upgrade things are odd

See [upgrading-and-backups.md](upgrading-and-backups.md). If you downgraded the
tag instead of restoring a backup, that's the likely cause.

## Resource sizing

**No load testing has been done.** These are single readings, not guarantees.

Measured with `docker stats` and `docker images` on the `0.7.0` images, a
freshly started stack with a tiny dataset (2 users, 1 community, 1 message, 1
upload), no clients connected, on Docker Desktop (Windows) showing 37 GiB of
memory to containers:

| | Memory | CPU | Image size |
|---|---|---|---|
| server | 91 MiB | ~0% | 675 MB |
| client (nginx) | 6 MiB | ~0% | 74.6 MB |
| postgres | 65 MiB | ~0% | 419 MB |

Disk: the Postgres data directory was 47 MB on a brand-new cluster with
essentially no data; the uploads volume held only the one test file.

What this does and doesn't tell you: it's a floor for idle memory, nothing more.
Memory and CPU will grow with connected clients (each holds a WebSocket) and
message volume, and uploads grow with usage and `MAX_UPLOAD_BYTES` (default
8 MiB per file) - none of which was measured. The compose file sets no resource
limits, so none are enforced; if you add them, leave headroom above the idle
numbers and watch the real usage for your own load. More than one server replica
needs Redis and shared (S3) uploads - see [scaling.md](../scaling.md).
