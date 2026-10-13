# Local development

> Part of the [documentation](../../README.md#documentation) and the
> [deployment guides](README.md).

How to run the whole stack on your own machine to use or change the code. This
is **not** a way to host a server for other people - for that, see
[Docker Compose](docker.md).

Everything here was run on Windows (PowerShell 5.1, Docker Desktop, Node 24.15)
from a **fresh clone** of the repository. CI and the published images use Node
22; the repo declares no `engines` field, and 24.15 worked. The `.ps1` scripts
are Windows PowerShell; the [manual way](#the-manual-way) is the route on
Linux/macOS and was **not** run on those platforms.

## What you get

| | Where |
|---|---|
| Server (API + WebSocket, `tsx watch`) | `http://localhost:4000` |
| Client (Vite dev server) | `http://localhost:5173` |
| PostgreSQL (Docker, `docker-compose.yml`) | host port **5433** (not 5432), user/password/database `chat` |
| Data | Docker volume `my-chat-app_postgres-data` |
| Logs | `.run\server.log`, `.run\client.log` (plus `.err.log` for each) |

Defaults come from `server/.env.example` and `client/.env.example`, copied for
you on first run. Their JWT secrets are placeholders, so releases after `0.9.0` print
`WARNING: insecure configuration - fine for local development` on every start of the dev
server; that is expected there and is only a refusal in a deployment. Two things matter for the browser: the client's
`VITE_API_URL` is `http://localhost:4000`, and the server's `CORS_ORIGIN` is
`http://localhost:5173`.

## Quick start (Windows)

```powershell
git clone https://github.com/sam-bowman/federated-chat-app
cd federated-chat-app
.\scripts\start.ps1
```

The checkout folder can have any name: `docker-compose.yml` pins the Compose project name, so the
container is always `my-chat-app-postgres-1`. (Before that was pinned, `start.ps1` only worked in a
folder literally called `my-chat-app` - [#88](https://github.com/sam-bowman/federated-chat-app/issues/88);
an older checkout still has that limit.)

**Known problem on a fresh checkout** ([#86](https://github.com/sam-bowman/federated-chat-app/issues/86)):
the first run installs dependencies but never generates the Prisma client, so the
server dies immediately while the script still ends with `My Chat App is up`.
Generate the client once and run the script again - this exact sequence was
verified to give a working server:

```powershell
npx prisma generate --schema server/prisma/schema.prisma
.\scripts\start.ps1
```

On the first run the script printed, in order: Docker check, Postgres container
created and started, `PostgreSQL is healthy.`, `Created server\.env from .env.example`
(and the client's), `npm install` for each workspace, `prisma migrate deploy`
(`6 migrations found`, then `No pending migrations to apply` in my run, because the volume
already held a migrated database), then starts both
processes in the background. Open `http://localhost:5173`, register a user, and
you're in. A second account needs a separate browser profile (tokens live in
`localStorage` - see the README note).

```powershell
.\scripts\stop.ps1
```

Stops both processes (it kills the whole process tree from the PID files in
`.run\`) and removes the Postgres container. **Your data stays** in the Docker
volume; the next `start.ps1` picks it up. The scripts are safe to re-run.

> If you launch `start.ps1` from something that waits for its output to finish
> (a CI step, an editor task, an automation tool), it will look hung: the server and
> client it starts keep the output pipe open. In a normal terminal it returns.

### The manual way

Run the three pieces yourself - see the README's
[Getting started](../../README.md#the-manual-way). That path was not re-run for this
guide. It differs in one useful way: `npm run prisma:migrate` in `server/` is
`prisma migrate dev`, which *does* generate the Prisma client.

### Two servers, to try federation

`scripts\start-federation-demo.ps1` runs `alice.test` and `bob.test` side by side;
see [federation-demo.md](../federation-demo.md). It was not run for this guide. Reading
it, it installs and migrates the same way as `start.ps1` and has no generate step
either, so expect the same first-run problem.

## Upgrading your checkout

`git pull`, then `.\scripts\start.ps1` again: it runs `npm install` only when
`node_modules` is missing, so run `npm install` yourself after a pull that changes
dependencies, and `npx prisma generate --schema server/prisma/schema.prisma` after
one that changes `server/prisma/schema.prisma`. Pending migrations are applied on
every start. Migrations only move forward, so after switching to an older branch
the database can be ahead of the code - the same hazard described in
[upgrading-and-backups.md](upgrading-and-backups.md#why-re-tagging-is-not-a-rollback).
Releases after `0.9.0` make that visible: the server then exits with
`Refusing to start: the database has N migration(s) this version does not know about`
(set `ALLOW_UNKNOWN_MIGRATIONS=true` in `server/.env` to override it for a branch you know is
fine). Dev data is not meant to be precious; deleting the volume
(`docker compose down -v`, which destroys the dev database) is the reset.

Tests need a separate `chat_test` database - see [testing.md](../testing.md).

## Troubleshooting

Messages are from real runs.

### "My Chat App is up" but nothing loads or API calls fail
Read `.run\server.err.log`. On a fresh checkout it contains:
```
Error: @prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.
```
Run `npx prisma generate --schema server/prisma/schema.prisma` and `start.ps1` again
([#86](https://github.com/sam-bowman/federated-chat-app/issues/86)). The script does
not check that the server actually answers, so its "up" message proves nothing:
`curl http://localhost:4000/healthz` should return `{"ok":true}`.

### `PostgreSQL did not become healthy in time`
If `docker ps` shows the container as `healthy` under a name other than `my-chat-app-postgres-1`, you
are on a checkout from before the project name was pinned ([#88](https://github.com/sam-bowman/federated-chat-app/issues/88));
pull and re-run. Otherwise the script's own hint applies: `docker compose logs postgres`.

### "Something is already listening on port 4000 - leaving it alone"
```
Something is already listening on port 4000 - leaving it alone (server likely already running).
```
The script only checks that *something* owns the port. With an unrelated program on 4000
the script still printed `My Chat App is up`, the client started, and `/healthz` got no
answer ([#87](https://github.com/sam-bowman/federated-chat-app/issues/87)). Find and stop
what owns the port (`netstat -ano | findstr :4000`), or free it and re-run. Port 5173 is the
same. If **5433** is taken, change the mapping in `docker-compose.yml` and the port in
`server/.env` together.

### Login or register suddenly returns 429
```
HTTP/1.1 429 Too Many Requests
Too many requests, please try again later.
RateLimit-Limit: 10
Retry-After: 900
```
Auth routes allow **10 requests per 15 minutes per IP**, counting failures. Ten wrong
logins made the 11th a 429. The counter is in the server process's memory, so reloading
the server clears it: touching a file under `server/src` made `tsx watch` restart and the
next request got a normal `401`. For development you can raise `AUTH_RATE_LIMIT_MAX` (and
`RATE_LIMIT_MAX`) in `server/.env`; that variable is documented in `.env.example` but
changing it was not tested here. See [security.md](../security.md#rate-limiting).

### The page loads, but requests are blocked (CORS)
Open the client at exactly `http://localhost:5173` - not `127.0.0.1`, not another port.
The server accepts only the origins in `CORS_ORIGIN` (just `http://localhost:5173` by default),
each compared as a string; see
[docker.md](docker.md#the-page-loads-but-every-request-fails-cors) for the real error
message.

### Docker isn't running
Per the script (not tested here): it tries to launch Docker Desktop from
`C:\Program Files\Docker\Docker\Docker Desktop.exe`, waits up to 90 seconds for the engine,
and otherwise throws. If your Docker Desktop is installed elsewhere, start it yourself first.

### Database errors
The `P1000` / `P1001` messages and what they mean are in
[docker.md](docker.md#p1000-authentication-failed-against-database-server). For this stack the
credentials are always `chat`/`chat` on `localhost:5433`.

## Resource sizing

Not measured, and not meaningful here: it's one Postgres container plus two Node
processes (`tsx watch` for the server and Vite for the client), which grow with your
editor-driven reloads rather than with users.
