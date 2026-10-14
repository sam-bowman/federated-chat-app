# Testing

> Part of the [documentation](../README.md#documentation).

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
replicas](scaling.md#running-multiple-replicas) depends on; it needs a real Redis (see
below) and is the one file in this suite that doesn't run with Redis unset.

> **Run the integration suite only through `npm run test:integration --workspace server`.** It truncates every table between tests, so
> `resetDb()` refuses any database whose name does not end in `_test`, and the default `vitest` config runs only the unit tests in `src/`.
> A bare `npx vitest run` in `server/` used to reach the integration tests with the dev database from `server/.env` and wipe it.

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

## Coverage

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

## CI pipeline

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
