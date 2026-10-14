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

### What runs when

Not every change needs every check, so a first job (`changes`, see
`.github/scripts/ci-tier.mjs`) works out a *tier* and the others skip themselves
with `if:` when they are not needed:

| Tier | When | Runs |
|---|---|---|
| `full` | a pull request that changes code or configuration (and anything the classifier is unsure about, or a manual run) | everything above |
| `light` | a release-please PR whose files are only the changelog and version numbers | lint, typecheck & build, Helm lint, dependency audit and review, secret scan, CodeQL (not the unit and integration suites) |
| `docs` | a pull request that changes only `docs/`, `protocol/`, `*.md` or `LICENSE` | secret scan and CodeQL |
| `push` | a push to `master` | CodeQL only: the commit has the content of a pull request that already passed everything (merging requires an up-to-date branch), and CodeQL's analysis of `master` is the baseline pull requests are compared with |

Each run says which tier it chose in its **Decide what to run** job (and on the run's summary page),
with the reason, so a surprising skip can be explained without reading the script.

Typical durations of the slowest jobs for a `full` pull request, from the Actions history after the
integration suite was sped up (see #133): integration tests about 1.7-2.2 minutes (they were
3.5-5.5), CodeQL about 1 minute, unit tests and typecheck & build under a minute each. A push to `master` is now
just the CodeQL run, about 1.5 minutes.

A few rules the logic keeps:

- **`light` is earned by the diff, not the branch name.** The branch has to be
  `release-please--...` *in this repository*, every changed file has to be one release-please
  rewrites, and the changed lines in each (including `package-lock.json`) have to be version
  lines and nothing else. A dependency change, a source file, a rename or a patch GitHub
  did not show makes it `full`. `ci-tier.test.mjs` checks this against the real file lists
  of a release PR and of a dependency-adding PR.
- **A failure to classify means run everything.** The classifier catches its own errors, and
  every job's `if:` treats a failed `changes` job as `full`.
- **CodeQL never skips on a pull request**: the branch ruleset requires its result for the head
  commit, so a missing analysis would block the merge.
- **Skipping uses `if:`, never a `paths:` filter on the workflow.** A job skipped by `if:`
  reports as skipped, which satisfies a required check; a workflow skipped by `paths:`
  leaves its required checks pending, and the pull request can never merge.
- A run on `master` is never cancelled by a newer one (a cancelled CodeQL run leaves that
  commit without a baseline); a pull request's older runs are.
