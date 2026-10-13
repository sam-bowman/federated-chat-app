# Native binaries

> Part of the [documentation](../../README.md#documentation) and the
> [deployment guides](README.md).

Run the server and client without Docker. Every tagged release attaches a
`.tar.gz` of each for Windows (`win32-x64`), Linux (`linux-x64`) and macOS
(`darwin-arm64`) to the GitHub Release, built with
[Node's Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)
(`.github/workflows/publish-binaries.yml`; see [distribution.md](../distribution.md)).
You still need a **PostgreSQL database you provide** - nothing here installs one.

Everything below was run with the **real `v0.8.0` Windows archives** (and the
`v0.7.0` server for the upgrade tests) against a PostgreSQL 16 container. The
Linux and macOS archives were **not run** - see
[what was not tested](#what-was-not-tested).

## Quick start

Download the two archives for your platform from the
[releases page](https://github.com/sam-bowman/federated-chat-app/releases) and
extract each into its own folder:

```bash
tar xzf federated-chat-app-server-0.8.0-win32-x64.tar.gz
tar xzf federated-chat-app-client-0.8.0-win32-x64.tar.gz
```

The server's archive extracts to a `server/` folder:

```
server/my-chat-server-win32-x64.exe
server/node_modules/.prisma/client/     (Prisma's native query engine)
server/prisma/migrations/               (applied automatically at start)
```

**Keep the whole folder together** - the executable needs the other two next to it.
The client's archive is a single executable (`client/my-chat-client-win32-x64.exe`).

Create a file named `.env` **in the same folder as the server executable**:

```ini
PORT=4000
SERVER_DOMAIN=chat.example.com
SERVER_NAME=My Chat Server
DATABASE_URL=postgresql://chat:<password>@localhost:5432/chat
JWT_ACCESS_SECRET=<openssl rand -base64 32>
JWT_REFRESH_SECRET=<a different openssl rand -base64 32>
CORS_ORIGIN=https://chat.example.com
PUBLIC_BASE_URL=https://api.chat.example.com
```

Every setting is described in `server/.env.example`; `CORS_ORIGIN` is the web
client's exact origin and accepts **one** value (see
[docker.md](docker.md#configuration) for what each URL means). Then run:

```bash
./server/my-chat-server-win32-x64.exe
PORT=8080 API_URL=https://api.chat.example.com ./client/my-chat-client-win32-x64.exe
```

(POSIX-shell syntax, as run in Git Bash; in PowerShell set `$env:PORT` and
`$env:API_URL` first - not tested.)

On first start the server logs the migrations it applied and then that it is
listening:

```
Applied migrations: 20261002180054_init, 20261002191822_channel_read_and_save_trigger, ...
[My Chat Server] listening on :4000 (domain=chat.example.com)
```

`GET /healthz` returns `{"ok":true}`. Neither program daemonizes or restarts
itself - see [running as a service](#running-it-for-real).

### Where the server looks for files

Tested by running the executable from a *different* working directory:

- **`.env`** is read from the folder the executable lives in, not the current
  directory. Without one (and without the variables in the environment) it exits:
  ```
  Error: Missing required environment variable: DATABASE_URL
  ```
- **`uploads/`** is created next to the executable (a relative `UPLOADS_DIR` is
  resolved against it too). After uploading one file from another directory, it
  was in `server/uploads/` and nothing appeared in the working directory.
- Settings given as real environment variables are also read, and the `.env` file
  does not override variables already set - that is `dotenv`'s default behaviour,
  not separately tested here.

### The client

`PORT` (default `8080`) and `HOST` (default `0.0.0.0`) choose where it listens.
With `API_URL` set it is fixed to that server; with it unset you get the server
picker. The effective config is visible at `/env-config.js`:

```
window.__RUNTIME_CONFIG__ = {"API_URL":"http://localhost:14001"};     # fixed
window.__RUNTIME_CONFIG__ = {"API_URL":""};                           # picker
```

Single-page-app paths such as `/login` are served correctly.

## Running it for real

These are plain foreground processes with **no restart on failure**. If the server
process dies, it stays down until something starts it again - and in releases up to
and including `0.9.0`, an unhandled error in an async route killed it
([#76](https://github.com/sam-bowman/federated-chat-app/issues/76); newer releases
answer with a 500 and keep running). You need a
supervisor (systemd, a Windows service manager, launchd, ...). No unit or service
file is provided here because none has been tested; configure restart-on-failure
and make sure the working directory doesn't matter (it doesn't - see above).

Put a reverse proxy in front for TLS, as with [Docker](docker.md#quick-start), and
read the `trust proxy` caveat under
[rate limiting](../security.md#rate-limiting).

## Upgrading

Read [upgrading-and-backups.md](upgrading-and-backups.md) first, and take a
[backup](#backing-up-and-restoring). Then:

1. Stop the server.
2. Extract the new version's server archive into a **new folder**.
3. Copy your `.env` (and `uploads/`, if you use the disk driver) into it.
4. Start it.

Verified `0.7.0` -> `0.8.0` with a user and a community present: the new binary
logged `Applied migrations: 20261009174740_totp_2fa, 20261010172336_federated_communities`,
login worked and the community survived (with the known `localhost` backfill - see
[the fix](upgrading-and-backups.md#the-localhost-backfill)). The test ran the new
binary from a different folder with a copied `.env`; moving an existing `uploads/`
folder across was not part of it.

**Rolling back is a restore, not running the old binary.** The `0.7.0` binary started
fine against the `0.8.0` database and logged nothing unusual; creating a community
then crashed the process (`homeserverDomain` null), and with no supervisor it
stayed down. See
[why](upgrading-and-backups.md#why-re-tagging-is-not-a-rollback).

## Backing up and restoring

State: the PostgreSQL database and the `uploads/` folder next to the server
executable (unless you use S3), plus your `.env`. A database dump contains the
server's federation private key - see
[what state exists](upgrading-and-backups.md#what-state-exists).

```bash
pg_dump -Fc "postgresql://chat:<password>@localhost:5432/chat" > chat.dump
# uploads: copy or archive the uploads/ folder while the server is stopped (or accept
# that files uploaded during the copy may be missing)
```

The `pg_dump` command was run in exactly this URL form (from a `postgres:16`
client) and produced a valid archive; you need PostgreSQL's client tools
installed. Restoring - including the schema reset needed when the database is
newer than the dump - is described in
[upgrading-and-backups.md](upgrading-and-backups.md#restoring-into-a-database-that-already-has-data):
stop the server, reset the schema, `pg_restore`, put `uploads/` back, start the server.
The restore itself was verified on Kubernetes and Compose, not repeated with the binary.

## Troubleshooting

Messages are from real runs.

### `Missing required environment variable: DATABASE_URL`
No `.env` beside the **executable** (not your current directory) and nothing in the
environment. This also means that a `.env` left in the folder you launched from is
ignored.

### `Error: listen EADDRINUSE: address already in use :::4000`
```
Error: listen EADDRINUSE: address already in use :::14001
    at Server.setupListenHandle [as _listen2] ...
```
Another process owns `PORT`. Change `PORT` (and `PUBLIC_BASE_URL` to match). The
server exits with a stack trace rather than a friendly message.

### It starts but behaves like a different server
In releases up to and including `0.9.0` the built-in fallbacks for `SERVER_DOMAIN`
(`localhost`) and the JWT secrets (public development values) applied silently if you
left them out ([#77](https://github.com/sam-bowman/federated-chat-app/issues/77)).
Newer releases refuse to start a packaged binary like that and list what is missing
(`ALLOW_INSECURE_DEFAULTS=true` overrides it for a throwaway trial). That refusal was
verified on the built server in production mode and in the Docker image, not on a
packaged binary. Always set `SERVER_DOMAIN`, both secrets and `PUBLIC_BASE_URL`.

### CORS errors in the browser
[Same cause and fix as Docker](docker.md#the-page-loads-but-every-request-fails-cors).

### Database connection errors
Not captured for the binary. The Docker/Kubernetes guides show Prisma's `P1000`
(bad credentials) and `P1001` (unreachable host) messages; the binary uses a
different migration runner (`server/src/standaloneMigrate.ts`), so its wording was
not verified. A database name that doesn't exist is created silently
([#80](https://github.com/sam-bowman/federated-chat-app/issues/80)) on the Docker
path; not checked for the binary.

## Resource sizing

**No load testing has been done.** One reading each, from Windows `tasklist`
(working set) on the `0.8.0` binaries a few minutes after start with one user, one
community and one upload, no clients connected:

| | Memory (working set) | On disk (extracted) | Archive |
|---|---|---|---|
| server | ~111 MiB (113,628 K) | 106 MB | 41.9 MB (win32), 50.1 MB (linux), 45.6 MB (macOS) |
| client | ~41 MiB (41,516 K) | 84 MB | 33.3 MB (win32), 42.0 MB (linux), 36.5 MB (macOS) |

The server number is a Windows working set, which is not comparable to the
container figures in [docker.md](docker.md#resource-sizing) or
[kubernetes.md](kubernetes.md#resource-sizing). PostgreSQL is extra and depends on
how you run it. Uploads grow with use (`MAX_UPLOAD_BYTES`, default 8 MiB per file).

## What was not tested

- **Linux and macOS archives**: not downloaded or run (including whether the
  executable bit survives extraction, or macOS Gatekeeper behaviour).
- **Windows SmartScreen**: the binaries are not code-signed (the publish workflow has
  no signing step), but the archives were fetched with the GitHub CLI, not a browser,
  so no download warning was exercised.
- **Service managers**, TLS/reverse-proxy setups, and `HOST` binding other than the
  default.
- Configuring purely through environment variables (no `.env`).
