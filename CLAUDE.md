# CLAUDE.md

Guidance for Claude Code (or any coding agent) working in this repository.

## What this is

A federated, open-source communication platform — Discord-style communities and
channels, MSN-style friends/presence/DMs, custom emoticons — with real
server-to-server federation between independently-run homeservers. See
[README.md](README.md) for the full feature list, setup instructions, and
architecture notes; this file is about how to work in the repo, not what it does.

Two npm workspaces:

- `server/` — Node.js + TypeScript, Express, `ws`, Prisma + PostgreSQL
- `client/` — React + TypeScript + Vite

Federation (`server/src/lib/federation/`, `server/src/modules/federation/`) is a
signed HTTP protocol between homeservers — read README's "Architecture notes —
federation" and "Known federation limitations" before changing anything there.

## Commands

Run from the repo root unless noted.

**Dev servers**
- `.\scripts\start.ps1` / `.\scripts\stop.ps1` — single-server local dev (Postgres + server + client)
- `.\scripts\start-federation-demo.ps1` / `.\scripts\stop-federation-demo.ps1` — two independent homeservers (`alice.test` / `bob.test`) for testing federation end to end
- `docker compose up -d redis` — only needed to test multiple replicas of the *same* homeserver (set `REDIS_URL=redis://localhost:6380`); not started by either script above, since a single replica never needs it. See README "Running multiple replicas".

**Build / typecheck / lint**
- `npm run build --workspace server` — `tsc`
- `npm run build --workspace client` — `tsc -b && vite build`
- `npm run typecheck --workspace server` — also typechecks `server/test/` (the build script above deliberately excludes it, so this is the only thing that checks it)
- `npm run lint --workspace client` — oxlint

**Tests** — see README "Testing" for the full picture
- `npm run test --workspace server` / `npm run test --workspace client` — unit tests, no database
- `npm run test:integration --workspace server` — full API + federation tests against a real Postgres database (needs a `chat_test` database — see README)
- `npm run test:coverage --workspace <server|client>` / `npm run test:integration:coverage --workspace server` — same, with coverage. The integration run **enforces** a coverage floor (`server/vitest.integration.config.ts`); if a change would drop it, add tests rather than lowering the threshold.

**Database**
- `npx prisma generate --schema server/prisma/schema.prisma` — regenerate the Prisma client after any schema change (do this before `tsc`/editors will see correct types)
- `npx prisma migrate dev` (from `server/`) — create a new migration during development
- A **breaking** schema change that needs a data backfill can't run non-interactively via `prisma migrate dev`. Use `prisma migrate diff --script` to get raw SQL, hand-edit in the backfill `UPDATE`, apply via `prisma migrate deploy`. `server/prisma/migrations/20261005105346_federation_identity_model/migration.sql` is a worked example (backfilled `homeserverDomain` for pre-existing local users).

## Repo-specific conventions

- **Every federatable object has a `protocolId` (ULID), separate from its local DB id.** API responses only ever expose `protocolId`, never the DB id. Follow this for any new federatable model.
- A remote user is an ordinary `User` row with `isRemote: true`, carrying the **real** `protocolId` from their home server — never generate a fresh one for a remote stub. Getting this wrong broke cross-server presence/message matching once; see the protocolId regression test in `server/test/integration/federation.test.ts`.
- `publicUser(user, viewerId?)` hides `INVISIBLE` presence as `OFFLINE` unless `viewerId === user.id`. Pass `viewerId` at any new "render another user" call site — omitting it safely defaults to hiding, which is deliberate, not a bug to paper over.
- Any new WebSocket event tied to a specific conversation/channel must carry that id in its payload (`conversationId`/`channelId`). Relying on implicit context caused real message cross-contamination between an open DM and an open channel once.
- Key a `useEffect` off `user?.id`, not the whole `user` object from `AuthContext` — `user` gets a new object identity on every profile/presence refresh, not just login/logout. Getting this wrong in `WsContext.tsx` caused presence changes to silently revert; see its regression test.
- Windows dev note: in this shell, `cd X && long-running-cmd &` only applies the `cd` inside the backgrounded job, not the parent shell, because `&&` binds tighter than `&`. Wrap it: `(cd X && long-running-cmd &)`.
- Postgres is mapped to host port **5433**, not 5432 (see `docker-compose.yml`) — many dev machines already have something on 5432. Redis (optional, see below) is on **6380**, not 6379, same reasoning.
- All WebSocket delivery goes through `sendToUser`/`sendToUsers` in `server/src/ws/gateway.ts` — never write to the module's `connections` map directly from elsewhere, and never call a socket's `.send()` outside that file. With `REDIS_URL` set, those two functions publish to Redis instead of delivering directly (see `server/src/ws/presenceFanout.ts`); calling anything lower-level would bypass cross-replica fan-out silently.
- Prisma on Alpine (`server/Dockerfile`) needs **two** separate fixes, not just one: `binaryTargets` in `schema.prisma` (controls `@prisma/client`'s query engine) *and* `apk add openssl` in the image (the `prisma` CLI's own migration engine does its own OpenSSL auto-detection by shelling out to `openssl`, which Alpine doesn't ship by default). Missing either one fails silently at the wrong layer - a `prisma generate` that looks fine, then `prisma migrate deploy` crashing at container start with an opaque "Could not parse schema engine response" error that doesn't mention OpenSSL at all. Since the image is published for both amd64 and arm64, `binaryTargets` needs **both** musl variants (`linux-musl-openssl-3.0.x` and `linux-musl-arm64-openssl-3.0.x`) - missing the arm64 one wouldn't fail the build, only the arm64 container at startup.
- Both Dockerfiles build from the **repo root** as context, not their own directory (npm workspaces - the root `package-lock.json` is needed). `docker build -f server/Dockerfile .`, not `cd server && docker build .`.

## Testing philosophy

There was no automated testing before this project's CI/test suite was added —
every early bug was found by manual browser testing. A meaningful chunk of the
integration suite is regression tests written directly against real bugs found
that way (presence leaking true status over REST, message cross-contamination,
federation protocolId mismatches, the WsContext reconnect bug) — each has a
comment explaining the original bug and why the test catches it. When fixing a
bug, add a test in that style, not just a prose explanation in the PR.

## Git workflow

**`master` is protected** — direct pushes are rejected by the repo ruleset
("Require PR"), and it applies to everyone including the owner (empty bypass
list). All work goes through a branch and a pull request.

- **Branch names**: `<type>/<short-description>`, matching the commit types
  below — e.g. `feat/federated-group-dms`, `fix/presence-invisible-leak`,
  `chore/bump-prisma`.
- **Commit messages**: [Conventional Commits](https://www.conventionalcommits.org/) —
  `<type>[optional scope]: <description>`. Examples:
  - `feat(federation): relay typing indicators across servers`
  - `fix(client): stop WsContext reconnecting on presence refresh`
  - `test(server): add regression test for message cross-contamination`
  - `docs: document the federation demo restart-resilience check`
  - `chore: bump vitest to 5.1`

  Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`,
  `ci`, `build`. Add a scope (`server`, `client`, `federation`, or a module
  name) when a change is obviously scoped to one area; omit it for
  repo-wide changes. This applies to **every commit**, not just the final one
  on a branch.
- **Merging**: squash-only (the only merge method the ruleset allows). The PR
  title becomes the squash commit's message — **write the PR title as a
  Conventional Commit too**, since that's what ends up in `master`'s history.
- Required approvals are set to 0 (solo maintainer — GitHub won't let you
  approve your own PR), so **passing required status checks is the actual
  merge gate**, not review.
- **Never hand-edit `CHANGELOG.md`** — [release-please](https://github.com/googleapis/release-please)
  (`.github/workflows/release-please.yml`) generates it from Conventional Commit
  PR titles automatically, and a manual edit just gets overwritten. This makes
  the PR title double as the changelog entry, so write it the way a reader of
  `CHANGELOG.md` would want to see it, not a terse commit-log summary. Version
  numbers are lockstep across `package.json`/`server/package.json`/
  `client/package.json` — see `VERSIONING.md` for the full bump policy (pre-1.0,
  breaking changes bump MINOR, not MAJOR) and exactly how a release gets cut
  (short version: release-please opens a standing Release PR as commits land;
  merging it is the one manual step, and it's what controls release timing).

## What the `master` ruleset currently enforces

("Require PR" ruleset, Settings → Rules → Rulesets)

- Require a pull request before merging — 0 required approvals, squash-only merge method
- Require status checks to pass — all 8 CI jobs pinned as required: `Lint`,
  `Typecheck & build`, `Unit tests`, `Integration tests`,
  `Dependency vulnerability audit`, `Dependency review (PR diff)`,
  `Secret scanning`, `CodeQL analysis`. Also requires branches to be up to date
  before merging.
- Require code scanning results — **CodeQL**, blocking on Security alerts "High or higher" / Alerts "Errors"
- Require linear history
- Restrict deletions, block force pushes
- Bypass list: empty

**Not enabled**, deliberately:
- Required approvals beyond 0 — would make the repo unmergeable solo
- "Require code quality results" — no tool produces that specific result type yet
- "Restrict code coverage" — GitHub's native version needs a specific coverage-upload mechanism this repo doesn't produce; the real coverage gate is the `integration-tests` CI job's own enforced threshold instead (see README "Testing" → "Coverage")

`.github/workflows/ci.yml` (what actually runs on every push/PR to `master`):
`lint`, `typecheck-and-build`, `unit-tests`, `integration-tests` (enforces the
coverage floor), `dependency-audit`, `dependency-review` (PRs only),
`secret-scan`, `codeql`.
