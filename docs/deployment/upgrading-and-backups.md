# Upgrading and backups

> Part of the [documentation](../../README.md#documentation). Shared by every
> [deployment guide](README.md) - Docker Compose, Kubernetes, native binaries.

Everything here was run against real published images (`0.7.0` -> `0.8.0`, with
data in the database and an uploaded file), not inferred from the code. Where
something is only read from the code and not run, it says so.

## The short version

1. **Back up before every upgrade** - database *and* uploads ([how](#backing-up)).
2. Upgrade by pointing at the new version; migrations apply themselves on start.
3. **There is no downgrade.** Pointing back at the old version is not a rollback
   ([why](#why-re-tagging-is-not-a-rollback)). To go back, restore the backup you
   took in step 1.

## Versions

Releases follow semver, pre-1.0, with app, server and client versioned in
lockstep - see [versioning.md](../versioning.md). Pre-1.0, a **minor** bump
(`0.7.x` -> `0.8.0`) may be breaking; read that release's section in
[CHANGELOG.md](../../CHANGELOG.md) before upgrading across one. A patch bump
should need nothing beyond pulling the new version.

Pin an exact version (`IMAGE_TAG=0.8.0`) rather than `latest` so an upgrade is
something you chose and backed up for, not something a `pull` did.

## Migrations

The server runs `prisma migrate deploy` every time it starts
(`server/docker-entrypoint.sh` for the Docker image,
`server/src/standaloneMigrate.ts` for the native binary). Consequences:

- Upgrading is just starting the new version; there is nothing to run by hand.
- Migrations only move **forward**. There is no down-migration.
- If a migration fails, the server exits before listening. Under Docker's
  `restart: unless-stopped` it will restart and fail again, in a loop - look at
  `docker compose logs server`, don't wait for it to settle.
- `/healthz` only returns `{"ok":true}`; it doesn't check the database.

### Things to know about specific versions

| Upgrading to | What changes | What to do |
|---|---|---|
| **0.2.0** | Users get a `homeserverDomain` column; existing users are backfilled with the literal `localhost`. | If you have users from before 0.2.0 *and* a real `SERVER_DOMAIN`, **those accounts cannot log in** until repaired - see [the `localhost` backfill](#the-localhost-backfill). Releases after `0.9.0` repair it on start. |
| **0.8.0** | Communities become federated and get a `homeserverDomain` column, backfilled with the literal `localhost` the same way. Also adds two-factor (TOTP) tables. | Same fix, for communities. Nothing reads a *local* community's own value, so it does no harm today, but the community owner's domain is sent to other servers, so repair it too. Releases after `0.9.0` do. |
| **After 0.9.0** | `CORS_ORIGIN` becomes a list of bare origins, and `CORS_ORIGIN=*` (any origin, never documented but accepted by earlier releases) is no longer supported. The server also refuses to start with unset/placeholder JWT secrets or `SERVER_DOMAIN`, or against a database a newer version has migrated (see [Docker troubleshooting](docker.md#the-server-container-exits-at-once-with-refusing-to-start)). | If you set `CORS_ORIGIN=*`, replace it with the specific origins that call your server, comma-separated. Otherwise nothing, unless the startup checks name something you left unset. |

### The `localhost` backfill

Both migrations write the literal string `localhost`, not your `SERVER_DOMAIN` (a migration can't see environment
variables). If your `SERVER_DOMAIN` is something else, those rows are tagged with a domain that isn't yours.

**For users this is not cosmetic.** Login, search, friend lookups and federation all find a local account by
`homeserverDomain = SERVER_DOMAIN`, so a user still tagged `localhost` gets `401 invalid_credentials` with the right password,
can't be found by anyone, shows as `@name:localhost` in places that print the stored value, and their username can be registered a
second time. It only affects accounts created before 0.2.0 on a server that has a real domain; a fresh install is unaffected.
Communities (0.8.0) carry the same stale value, but nothing reads a local community's own value, so it does no harm by itself.

**Releases after `0.9.0` repair this on start.** After the migrations, the server rewrites local rows tagged `localhost` to
`SERVER_DOMAIN`, and logs, for example:

```
Repaired 1 local account(s) and 1 communit(ies) that an old migration had tagged 'localhost': they now belong to chat.example.com.
```

Verified end to end: a user and community were put in that state in a scratch database, login returned `401`, and after restarting
the server it returned `200` with identity `@pioneer:chat.example.com`. It is idempotent, does nothing on a server whose domain really
is `localhost` (development), and never touches remote users or remote communities.

If a username exists **twice** - the old `localhost` account and one someone registered later on the real domain, perhaps after being
locked out - the old one is left alone (renaming it would collide with the new one) and the server logs a warning naming it:

```
WARNING: 1 local account(s) are still tagged 'localhost' and cannot log in, because an account with the same username already exists on chat.example.com: twin. ...
```

Decide which one is the real person, rename or delete the other in the database, and restart. Take a [backup](#backing-up) first.

**On `0.9.0` or earlier**, do it by hand against the database, with your own domain (take a [backup](#backing-up) first; the
`NOT EXISTS` guard is the same collision protection):

```sql
UPDATE "User" AS u SET "homeserverDomain" = 'chat.example.com'
WHERE u."isRemote" = false AND u."homeserverDomain" = 'localhost'
  AND NOT EXISTS (SELECT 1 FROM "User" o WHERE o."username" = u."username" AND o."homeserverDomain" = 'chat.example.com');

UPDATE "Community" SET "homeserverDomain" = 'chat.example.com'
WHERE "isRemote" = false AND "homeserverDomain" = 'localhost';
```

Tracked in [#78](https://github.com/sam-bowman/federated-chat-app/issues/78).

## Why re-tagging is not a rollback

The obvious rollback - set `IMAGE_TAG` back to the old version and `up -d` - was
tried on a database that had been migrated to `0.8.0`:

- The `0.7.0` image **starts**. It runs `migrate deploy`, sees migrations it
  doesn't know about, and carries on without complaint. Nothing tells you the
  database is ahead of the code.
- Most things work. Anything that touches a column or table the old code doesn't
  expect fails. In releases up to and including `0.9.0` an unhandled error in an async
  route handler took down the whole server process (Express 4;
  [#76](https://github.com/sam-bowman/federated-chat-app/issues/76)), so the symptom was
  the server restarting; newer releases return a 500 `internal_error` and log the error
  instead - the request still fails, but the server stays up. (The crashes described
  below were observed on the older releases.)

So it looks fine for a while and then misbehaves in ways that depend on what
users happen to do. Don't do it.

Newer versions guard against this
([#83](https://github.com/sam-bowman/federated-chat-app/issues/83)): on start, the server
compares the migrations recorded in the database with the ones it ships, and if the
database has any it doesn't know, it exits with
`Refusing to start: the database has 1 migration(s) this version does not know about:`
followed by their names and the way out (upgrade, or restore a backup). That turns the
silent failure into a loud one - but only when the version you roll back **to** contains
the check, so it does not protect a rollback to `0.9.0` or earlier. `ALLOW_UNKNOWN_MIGRATIONS=true`
starts it anyway; use it only if you know the extra migrations are harmless.

The same thing was reproduced with `helm rollback` on Kubernetes (it prints
"Rollback was a success!", the old pod starts and logs "No pending migrations
to apply", and creating a community then crashes the server with
`P2011` / null `homeserverDomain`) and with the native `0.7.0` binary against a
`0.8.0` database (same crash - and with no service manager, nothing restarts it).

**A real rollback is a restore** of the database and uploads taken *before* the
upgrade, into a stack on the older version ([restoring](#restoring)). Anything
written between the backup and the restore is lost - that is the cost, and it's
why the backup has to happen right before upgrading.

## What state exists

| What | Where | In a backup? |
|---|---|---|
| Users, messages, communities, uploads' metadata | Postgres | Yes |
| **The server's federation signing key** (public and private) | Postgres, `ServerIdentity` table | Yes - see below |
| Uploaded files (avatars, attachments, emoticons) | the `uploads` volume / `UPLOADS_DIR`, **or** your S3 bucket | Only if you back it up separately |
| Secrets: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `POSTGRES_PASSWORD` | your `.env` / Helm values / orchestrator | **No** - keep them somewhere safe yourself |

Notes:

- **A database backup contains the federation private key.** Treat the dump like
  a credential: restrict who can read it, don't commit it, encrypt it at rest if
  it leaves the machine. Anyone holding it can sign requests as your server.
- If you lose the database and have no backup, a fresh start generates a *new*
  key, and other servers that already know you will see an identity change.
- If you change the JWT secrets, everyone is logged out (their tokens stop
  verifying). It is not data loss.
- `SERVER_DOMAIN` is baked into every user id. Changing it later breaks existing
  users; treat it as permanent.

## Backing up

These are the exact commands that were run. They assume the Docker Compose
install ([docker.md](docker.md)); `chat` is the database user and name that
`docker-compose.selfhost.yml` creates. Replace `<project>` with your Compose
project name (the default for `docker-compose.selfhost.yml` is
`federated-chat-app-selfhost`; `-p` overrides it).

**Database:**

```bash
docker exec <project>-postgres-1 pg_dump -U chat -Fc chat -f /tmp/chat.dump
docker cp <project>-postgres-1:/tmp/chat.dump ./chat.dump
```

**Uploads** (skip if you use S3 - back up the bucket with your provider's tools):

```bash
docker run --rm -v <project>_uploads-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/uploads.tgz -C /data .
```

On Windows, `docker cp` needs a relative destination like `./chat.dump`; a
Git-Bash `/tmp/...` path is not understood by the Docker CLI.

For Kubernetes or a self-run Postgres, the `pg_dump -Fc` part is the same; how
you reach the database differs - see the relevant guide.

A backup you've never restored is a hope, not a backup. Restore it into a
scratch stack once ([next section](#restoring)) before you need it.

## Restoring

This also *is* the rollback procedure. Run into a stack on the version the
backup was taken from. Tested end to end (login worked and the uploaded file was
served afterwards):

```bash
# 1. Stop the stack and delete its volumes (this destroys the current data)
docker compose -p <project> -f docker-compose.selfhost.yml --env-file .env.selfhost down -v

# 2. Create containers and volumes, but don't start anything yet
docker compose -p <project> -f docker-compose.selfhost.yml --env-file .env.selfhost up --no-start

# 3. Start only Postgres and load the dump
docker compose -p <project> -f docker-compose.selfhost.yml --env-file .env.selfhost up -d postgres
docker cp ./chat.dump <project>-postgres-1:/tmp/chat.dump
docker exec <project>-postgres-1 pg_restore -U chat -d chat --clean --if-exists --no-owner /tmp/chat.dump

# 4. Put the uploads back
docker run --rm -v <project>_uploads-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/uploads.tgz -C /data

# 5. Start everything, with IMAGE_TAG set to the version the backup came from
docker compose -p <project> -f docker-compose.selfhost.yml --env-file .env.selfhost up -d
```

Use the same `JWT_*` secrets as before, or everyone has to log in again.

### Restoring into a database that already has data

The steps above start from empty volumes. If the database you're restoring into
is still running - typical on Kubernetes or with your own Postgres - and has
been migrated **past** the dump (the whole point of a rollback), a plain
`pg_restore --clean --if-exists` fails: the newer tables hold foreign keys to
the older ones, so Postgres refuses to drop them.

```
pg_restore: error: could not execute query: ERROR:  cannot drop table public."User" because other objects depend on it
DETAIL:  constraint TotpRecoveryCode_userId_fkey on table public."TotpRecoveryCode" depends on table public."User"
```

It leaves a half-restored database behind. Stop the server first, then empty the
schema and restore into it:

```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
```

```bash
pg_restore -U chat -d chat --no-owner chat.dump
```

This deletes everything in that database - which is what a restore means, but
make sure you are connected to the right one. Tested on Kubernetes: after it,
the dump's users logged in, the dump's upload was served, and a user registered
*after* the backup was gone. Note that restoring uploads on top of an existing
directory does not remove files uploaded after the backup; they stay behind as
unreferenced files until you delete them by hand.

## Checklist for an upgrade

1. Read the release's section in [CHANGELOG.md](../../CHANGELOG.md).
2. Take a [backup](#backing-up) (database and uploads).
3. Change `IMAGE_TAG` (or the chart's image tag / the binary), then pull and start.
4. Watch the server log until it reports listening - a failed migration shows up here.
5. Log in, send a message, load an upload.
6. If it's wrong, [restore](#restoring) onto the old version.
