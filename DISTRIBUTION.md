# Distribution matrix

Every way this project is (or could be) packaged and shipped, for server and
client separately. This is the detailed reference `ROADMAP.md` points to for
this topic - that file tracks it as a couple of one-line items; this one
tracks the actual shape of each.

## Server

| Format | For | Status | Depends on |
|---|---|---|---|
| **Docker image** | Easy self-hosting - TrueNAS, Synology, Unraid, a VPS, etc. | ✅ Shipped, multi-arch amd64+arm64 (`server/Dockerfile`, published to GHCR on release - see README "Docker images") | — |
| **Native binary** (Windows/Linux/Mac) | Running a home server without Docker | Not started | Prisma's per-platform `binaryTargets` (same class of problem `server/Dockerfile` hit on Alpine - see `CLAUDE.md` - except now needing Windows/macOS/glibc-Linux targets, not just musl), plus a packaging tool: Node's own [Single Executable Applications](https://nodejs.org/api/single-executable-applications.html) is the native-to-the-stack option, `pkg`/`nexe` are the established third-party ones |
| **Helm chart** | Kubernetes hosting | Not started | Cleared - the Redis cross-replica fan-out (`server/src/ws/presenceFanout.ts`) this needed is done, so a chart with `replicas > 1` would actually work correctly today |

## Client

| Format | For | Status | Depends on |
|---|---|---|---|
| **Docker image** | Hosting the web client yourself | ✅ Shipped, multi-arch amd64+arm64 (`client/Dockerfile`, `API_URL` fixed per deployment via `env-config.js` - see README "Docker images") | — |
| **Docker image, multi-server mode** | The same image, but letting the people using it pick which home server to log into, rather than it being fixed per deployment | ✅ Shipped, free - see "Home-server picker" below | — |
| **Desktop app** (Windows/Mac/Linux) | A single-user app, not tied to any one server | Not started | Cleared (home-server picker done) - what's left is a packaging decision: Tauri (smaller binary, lower memory) vs. Electron (more mature ecosystem) |
| **Mobile apps** (iOS/Android) | Same idea, mobile | Not started | Cleared (home-server picker done) - what's left is realistically a separate React Native codebase (not a wrapped web view, given the realtime/WebSocket/background-notification work involved) + push notifications (APNs/FCM) |
| **Helm chart** | Hosting the web client on Kubernetes | Not started | The client Docker image (✅ done) - mechanically straightforward once started; the open design question is whether it's its own chart or a subchart of the server's, so a self-hoster can `helm install` one umbrella chart instead of wiring two together by hand |

### Home-server picker - done

Was the shared blocker for three of the four client formats above: today's
client used to have exactly one API endpoint, fixed at deploy time
(`VITE_API_URL` at build time, or `API_URL` at container start). A desktop
app, a mobile app, and a multi-tenant web deployment all need the *opposite*
- resolving `@user:domain` (or a bare domain) via `.well-known` at login
time, the way `scripts/start-federation-demo.ps1` already proved the
*protocol* supports.

Now built: the client has no default server unless `VITE_API_URL`/`API_URL`
is set (see `client/src/api/client.ts`'s `isFixedServerMode()`). Unset, it
shows a server-entry step before login (`client/src/pages/AuthPage.tsx`),
resolves the typed identity/domain via `.well-known`
(`client/src/api/discovery.ts`), and remembers which server a saved session
belongs to (`chat.homeServer` in `localStorage`). This is also why the
Docker image's "multi-server mode" above needed no separate toggle config -
"enabled" is just "don't set `API_URL`."

The `.well-known` route needed its own permissive CORS to make this work -
see the comment in `server/src/wellknown.ts` and `server/src/app.ts` for why
it's mounted before the app-wide `CORS_ORIGIN` policy, not behind it.
