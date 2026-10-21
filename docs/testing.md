# Testing

> Part of the [documentation](../README.md#documentation).

```bash
npm run test --workspace server          # unit tests - pure logic, no database
npm run test --workspace client          # client unit/component tests
npm run test:integration --workspace server   # full API + federation tests, real database
npm run test:e2e                              # the real client in a real browser, against two real servers
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

## End-to-end tests

`e2e/` runs the actual client in a real browser against two real homeservers, the way a person
uses it, using [Playwright](https://playwright.dev). It exists for the bugs no other layer
sees: the component tests never talk to a server and the integration tests never open a page.
Two of the bugs it was written for were found only by clicking through the two-server demo by hand
(a relay that left out the acting member's own server, and a proxied send whose WebSocket echo
drew the message twice); both are pinned here, and its first runs found a third (a message drawn
twice after a reload, fixed in #181).

What it covers (`e2e/tests/`):

| File | Flow |
|---|---|
| `auth.spec.ts` | register, sign out, sign back in; a wrong password is refused |
| `direct-messages.spec.ts` | friend request accepted and declined; send, edit and delete a message live between two people, and what a reload still shows |
| `communities.spec.ts` | create a community, join it by ID, talk in its channel, see what was said before joining |
| `discoverability.spec.ts` | hide in Settings -> Privacy: another server's people are told "No one with that name was found" until it is switched back on; friends keep talking while one is hidden; people on the same server can still find them |
| `contact.spec.ts` | choose who can send friend requests / start conversations in Settings -> Privacy: "people on this server" refuses another server's request until changed back; the same server still gets through; "people I share a community with" refuses until a community is shared (the home server is asked), then lets in; a friend can still start a conversation |
| `community-visibility.spec.ts` | choose who can join in the community's Settings: "only people on this server" is invisible to another server and open to its own; "only people with an invite" says so to someone with just the code, and opening it again lets them in; someone from another server already in stays in |
| `directory.spec.ts` | the directory, with `alice.test` publishing one and `bob.test` not: a public community is listed and joined from Browse (own server, and from the other through theirs); a non-public one is not listed; a server with no directory says so; people who chose to be listed are found and added, and people who did not, or who hide, are not |
| `federation.spec.ts` | friends across `alice.test` and `bob.test` message, edit and delete; a member from another server talks in a community (one copy each, saved on both servers); the echo of a proxied send arriving before its reply |

**Running it locally.** You need Postgres (`docker compose up -d postgres`; it is on host port 5433)
and a browser:

```bash
npm install
npx playwright install chromium            # once, about 150 MB
npm run test:e2e
```

or use a browser you already have and skip the download: `E2E_BROWSER_CHANNEL=msedge npm run test:e2e`
(or `chrome`). `npm run test:headed --workspace e2e` shows the browsers; `E2E_VERBOSE=1` also shows the
servers' own output; after a failure, `npx playwright show-report` (from `e2e/`) opens the trace.

Playwright starts everything itself (`e2e/playwright.config.ts`): two servers (`alice.test` on :4100,
`bob.test` on :4101) and two Vite clients (:5273, :5274), each server on its own database,
`chat_e2e_a` and `chat_e2e_b`, which `e2e/scripts/run-server.mjs` **drops and recreates** every time a
server starts. The ports and databases differ from the dev ones on purpose, so the suite runs while
your own demo is up and never touches `chat`, `chat_a`, `chat_b` or `chat_test`; the script refuses to
reset any database whose name does not end in `_e2e_a` / `_e2e_b`. `E2E_DATABASE_URL_BASE` points it at
a different Postgres (CI's is on 5432). Servers already running on those ports are reused outside CI.

**Writing a test.** Every test registers its own people (`signUp` in `e2e/support/app.ts` goes through
the real sign-up form and gives each a browser of their own), so tests never depend on each other or on
state, and they run in parallel. Use roles, labels and placeholders, not CSS classes, wherever the page
offers them. Wait by asserting on what you expect to see (`expect(...).toHaveCount`), never with a fixed
sleep, except to prove that something does NOT happen (a duplicate that would arrive a moment later).
A race that normally goes one way can be forced the other: the "echo before the reply" test holds the
HTTP reply back with `page.route` so the order it depends on is not left to chance. As everywhere in this
suite, check a new test would fail without the fix it guards (revert the fix, run it).

**Voice channels** (`e2e/tests/voice.spec.ts`) need a real LiveKit server, which the other tests do not. The spec is skipped unless
`E2E_LIVEKIT=1`, so a run without it still passes:

```bash
docker compose -f e2e/docker-compose.livekit.yml up -d     # stop the dev `livekit` service first: same ports
E2E_LIVEKIT=1 npm run test:e2e
docker compose -f e2e/docker-compose.livekit.yml down
```

Only server `a` gets LiveKit (`e2e/scripts/run-server.mjs`), and its webhook points at that server's port (4100). The browsers use fake
microphones and have the permission prompt answered for them.

**In CI** the `End-to-end tests` job runs on `full`-tier pull requests with a Postgres service
container, a LiveKit server (for the voice spec) and Chromium, and uploads the report and traces if it fails. It is **not a required check
yet**, so a browser run that is flaky for reasons unrelated to a change cannot block merges; once it has
run clean for a while it should be added to the ruleset's required checks.

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

> **Windows: do not use Node 24.15.0** ([#211](https://github.com/sam-bowman/federated-chat-app/issues/211)).
> That one release crashes a process now and then with exit code `3221226505`
> (`0xC0000409`, a fast-fail inside libuv, no message) while HTTP traffic is going
> through it. In the suites it is "Worker exited unexpectedly ... exit code
> 3221226505", a test file whose tests are missing from the summary
> ("`N passed (N+k)`"), and once in a while a lost file in the client suite or a
> Playwright start-up that dies with no output. It is not in the test runner, the
> database or this repository's code: a plain Express server and `superagent` with
> no Vitest at all crashes in about one run in four on 24.15.0, and **never** on
> 24.14.1, on **any release from 24.16.0 up**, or on Node 22 (what CI and the Docker
> images use, so Linux CI never saw it). The same four integration files lost ~20
> workers in 16 runs on 24.15.0 and none in 16 runs on 24.16.0 or on 22. Earlier
> theories (V8 coverage, one fork per file, `singleFork`) were wrong: `singleFork`
> was removed in Vitest 4 and had been doing nothing.
>
> So: use Node 22 (`.nvmrc`) or 24.16.0 and newer. `npm test` and friends refuse to
> start on 24.15.0 on Windows and say so (`scripts/check-node.mjs`, run by the
> `pretest` hooks); `ALLOW_KNOWN_BAD_NODE=1` runs anyway if you want to look at it.
> `package.json` `engines` makes `npm install` warn too. A run that does show a bare
> "Worker exited unexpectedly" on some other Node is worth a new issue, with the
> Node version.

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
- **e2e-tests** - the end-to-end suite above, against two servers on a Postgres service container.
  Not a required check yet.
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
| `full` | a pull request that changes code or configuration (and anything the classifier is unsure about, or a manual run) | everything above, including the end-to-end tests |
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
