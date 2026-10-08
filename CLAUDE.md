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
- `npm run build:binary --workspace client` — builds, then packages `dist/` into a single native executable for the *current* platform (`client/dist-bin/my-chat-client-<platform>-<arch>[.exe]`) via Node's [Single Executable Applications](https://nodejs.org/api/single-executable-applications.html) — see `DISTRIBUTION.md`'s client "Binary" row. Configure it the same way as the Docker image: an `API_URL` env var (unset → picker mode), `PORT`/`HOST` to bind (defaults `8080`/`0.0.0.0`).
- `npm run build:binary --workspace server` — same idea for the server (`server/dist-bin/my-chat-server-<platform>-<arch>[.exe]`, plus a `node_modules/.prisma/client/` folder and `prisma/migrations/` it ships alongside - see `DISTRIBUTION.md`'s server "Native binary" row). Applies pending migrations itself at startup (`server/src/standaloneMigrate.ts`) since it doesn't ship the `prisma` CLI.
- `npm run tauri --workspace client -- dev` / `... -- build` — the desktop app (`client/src-tauri/`, see `DISTRIBUTION.md`'s "Desktop app" row). Note the `--` before `dev`/`build`: without it, npm's own `--workspace` flag swallows the argument instead of passing it through to the `tauri` CLI. `dev` opens a real window pointed at the Vite dev server (inherits whatever `client/.env` sets, same as plain `npm run dev` - expected, not a bug, but means a local dev-mode run can look like fixed-server mode even though a real packaged build won't); `build` produces real installers under `client/src-tauri/target/release/bundle/`.
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
- `client/Dockerfile`'s `deps`/`build` stages are pinned to `FROM --platform=$BUILDPLATFORM ...`, deliberately *not* following the target platform in a multi-arch (amd64/arm64) build. The build output (static JS/CSS/HTML) is platform-independent, and `vite build`'s native esbuild/rollup binaries are known to hang indefinitely under GitHub Actions' QEMU user-mode emulation - a real incident, not a hypothetical: the arm64 leg hung for over an hour in CI before this fix, despite building fine in under a minute locally (different QEMU implementation). Only the final nginx `runtime` stage actually varies per target arch. `server/Dockerfile` doesn't need this - `tsc` and `prisma generate` haven't shown the same issue.
- `server/src/wellknown.ts` is mounted in `app.ts` **before** the app-wide `cors({ origin: config.corsOrigin })` middleware, with its own permissive `cors()`. This is deliberate, not an oversight to tighten later: a browser-based home-server picker needs to read this document from a domain the user just typed in, which by definition isn't in any configured origin allowlist. Every other route stays behind the single configured `CORS_ORIGIN`.
- `client/src/api/client.ts`'s server base URL is a mutable binding (`getHomeServer()`/`setHomeServer()`/`clearHomeServer()`), not the frozen constant it used to be - `isFixedServerMode()` (true when `VITE_API_URL`/runtime `API_URL` is configured) gates whether it can ever change. It stores a **bare origin only** (`{ domain, origin, serverName, registrationEnabled }`) - every call site already embeds the full path including `/api/v1`, so storing anything more than scheme+host+port there double-prefixes every request. See `client/src/api/discovery.ts` for how a typed identity/domain resolves into one of these.
- Client-side unit tests can't rely on `client/.env`'s `VITE_API_URL` being present - that file is gitignored and local-dev-only, so a test that implicitly depends on it will pass on a dev machine and fail in CI's clean checkout. `client/src/api/client.test.ts` sets `import.meta.env.VITE_API_URL` explicitly in its own `beforeEach` instead; verify any new test exercising fixed/picker-mode behavior the same way (run it with `client/.env` temporarily removed before trusting it).
- `mediaUrl()` (`client/src/api/client.ts`) requires an explicit `https?://` prefix before trusting a path as already-absolute, rather than a looser `startsWith("http")` check - `path` is server-controlled data (attachment/avatar/emoticon URLs) rendered directly into JSX `<img src>`/`<a href>`, and CodeQL flags that pattern repo-wide as a DOM-XSS sink. A crafted scheme (`javascript:`, `data:`, even `httpevil:`) now gets treated as a relative path - turned into an inert path segment on this origin - instead of reaching the DOM as typed.
- `client/src/bin/` (the client's native-binary entry - see `DISTRIBUTION.md`'s client "Binary" row) is Node-context code - no DOM, needs `@types/node` globals (`process`, `Buffer`) - so it's excluded from `tsconfig.app.json` (browser/React scope, deliberately has no Node types to avoid leaking server-side globals into app code) and included in `tsconfig.node.json` instead, the same split that file already drew for `vite.config.ts`. Putting a Node-context file under plain `tsconfig.app.json` scope fails with "Cannot find name 'process'"-style errors that look like a missing `@types/node` install, when the real issue is which tsconfig covers it.
- Node's Single Executable Applications (both native binaries) can't `require()` an **external, unbundled** package by its bare specifier - only actual Node builtins resolve that way; anything else throws `ERR_UNKNOWN_BUILTIN_MODULE`, confirmed empirically when `@prisma/client` was left external to the server's esbuild bundle. The fix is to fully bundle a dependency's JS instead of marking it external - a *native* addon (a real `.node` file, not JS) still can't be bundled either way, so it ships as a loose file and gets `require()`'d via a real resolved filesystem path, which SEA doesn't restrict the same way. `server/src/config.ts`'s `PRISMA_QUERY_ENGINE_LIBRARY` override exists because of this exact split.
- The server's native binary didn't need any `binaryTargets` changes in `schema.prisma` for Windows/macOS/glibc-Linux, unlike what packaging a binary first looked like it would require - `"native"` already resolves correctly on each, *because* `server/scripts/build-binary.mjs` builds on each target OS natively (no cross-compilation, unlike the Docker multi-arch work). `binaryTargets` only needed explicit non-native entries when build-time platform and runtime-target platform differ, which was true for Docker (build on an amd64 CI runner, target Alpine/musl, sometimes arm64 via QEMU) and isn't true here.
- Prisma's `$executeRawUnsafe` cannot run more than one SQL statement per call, even with zero parameters - confirmed empirically ("cannot insert multiple commands into a prepared statement"), since Prisma's query engine always uses the prepared-statement protocol regardless. `server/src/standaloneMigrate.ts`'s `splitStatements()` exists because of this - a plain `.split(";")` would be wrong too, since it'd corrupt a semicolon inside a quoted string or a `$$`-delimited function/trigger body.
- `client/public/favicon.svg` uses CSS Color 4 `color(display-p3 ...)` fill overrides (a wide-gamut-with-sRGB-fallback pattern: `style="fill:#863bff;fill:color(display-p3 .5252 .23 1)"` - browsers correctly ignore the whole second declaration and keep the hex fallback when they don't support `color()`, which is the intended behavior). Tauri's icon generator (`tauri icon`, uses `resvg`) doesn't implement that fallback - it renders those shapes solid black instead of silently ignoring the unsupported function. The desktop app's icons were generated from a stripped copy with the `color(display-p3 ...)` declarations removed (keeping the identical hex fallback colors, not a design change), not from the committed favicon directly - regenerate the same way if the icon ever needs updating, don't just point `tauri icon` at `favicon.svg`.
- Tauri v2's Windows WebView2 serves the app from the origin `http://tauri.localhost`, not `http://localhost:<port>` or a `tauri://` scheme - confirmed empirically (the server's `CORS_ORIGIN` has to match this exactly for real API calls to succeed through the desktop app, discovery itself works regardless since `.well-known` has its own permissive CORS). Hasn't been verified on macOS/Linux, where Tauri uses the OS's own WebKit instead of WebView2 and the effective origin may differ - confirm this for real before assuming it's the same everywhere.
- `client/src-tauri/tauri.conf.json`'s `build.beforeDevCommand` is literally `npm run dev` - meaning `npm run tauri -- dev` inherits whatever `client/.env` sets (if anything) exactly like a plain `npm run dev` would. On a dev machine with `VITE_API_URL` set in `client/.env` (the normal single-server local dev setup), the desktop app in dev mode will show fixed-server-mode UI, not the picker - this is correct/expected, not a bug, and doesn't reflect what a real packaged build does. `npm run tauri -- build` runs `vite build` the same way `npm run build` does, so it's subject to the exact same `.env`-presence behavior the home-server-picker tests already have to account for - verify picker mode in a real build by temporarily removing `client/.env` first, matching how CI's clean checkout (no `.env` file at all) actually builds it.
- `server/src/config.ts`'s `dotenv.config({ path: ... })` call must pass `process.env.DOTENV_CONFIG_PATH` through explicitly on the non-packaged-binary branch - `dotenv`'s *programmatic* `config()` API (unlike the old side-effecting `import "dotenv/config"` it replaced during the native-binary work) only reads that env var when you forward it yourself; passing `path: undefined` always falls back to plain cwd-relative `.env` and silently ignores `DOTENV_CONFIG_PATH`. This broke `scripts/start-federation-demo.ps1` (which runs two server instances via `set DOTENV_CONFIG_PATH=.env.a&& npm run dev` / `.env.b`) as an unintended regression of that refactor - both instances loaded the same default `.env`, so the second one crashed on a port conflict with no useful error in its log. Fixed by threading `process.env.DOTENV_CONFIG_PATH` through on the dev-mode branch.
- `server/src/lib/federation/ssrfGuard.ts`'s `assertPublicHost(hostname)` guards every outbound federation request against a caller-supplied domain (SSRF) - a locally-authenticated user can type any `@user:domain` as a friend-request/DM target, and nothing upstream of `discovery.ts`/`client.ts` stops them pointing it at an internal address otherwise. It's skipped specifically when the domain resolves via `FEDERATION_PEER_OVERRIDES` (operator-set local dev config, e.g. the `alice.test`/`bob.test` demo pointing at real `localhost` ports) - that's operator-trusted, not attacker input, and must keep working unguarded.
- Two `express-rate-limit` instances must never share the same `RedisStore` key prefix, even when one is meant to "stack" more strictly on top of the other (`server/src/middleware/rateLimit.ts`'s `generalLimiter` + `authLimiter`, both keying on the same `req.ip` for `/api/v1/auth/*` requests) - express-rate-limit's own `ERR_ERL_DOUBLE_COUNT` validation throws if it ever sees the same `(store, prefixed key)` pair incremented twice for one request, which is exactly what two differently-scoped limiters sharing a prefix would do. Give each limiter its own `RedisStore({ prefix })`.
- Rate-limit thresholds (`RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX`, see README "Rate limiting") are read from env with low production defaults (300 / 10 per 15 min) - `test/setupEnv.ts` raises both way up by default so ordinary integration-test traffic (e.g. a single file registering a dozen users) never trips them incidentally; `test/integration/rateLimit.test.ts` and `rateLimit.redis.test.ts` are the two files that intentionally override them back down to actually exercise the 429 behavior, restoring the env vars in their own `afterAll` the same way `presenceFanout.test.ts` restores `REDIS_URL`.

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
