# Distribution matrix

Every way this project is (or could be) packaged and shipped, for server and
client separately. This is the detailed reference `ROADMAP.md` points to for
this topic - that file tracks it as a couple of one-line items; this one
tracks the actual shape of each.

## Server

| Format | For | Status | Depends on |
|---|---|---|---|
| **Docker image** | Easy self-hosting - TrueNAS, Synology, Unraid, a VPS, etc. | ✅ Shipped (`server/Dockerfile`, published to GHCR on release - see README "Docker images") | — |
| **Native binary** (Windows/Linux/Mac) | Running a home server without Docker | Not started | Prisma's per-platform `binaryTargets` (same class of problem `server/Dockerfile` hit on Alpine - see `CLAUDE.md` - except now needing Windows/macOS/glibc-Linux targets, not just musl), plus a packaging tool: Node's own [Single Executable Applications](https://nodejs.org/api/single-executable-applications.html) is the native-to-the-stack option, `pkg`/`nexe` are the established third-party ones |
| **Helm chart** | Kubernetes hosting | Not started | Cleared - the Redis cross-replica fan-out (`server/src/ws/presenceFanout.ts`) this needed is done, so a chart with `replicas > 1` would actually work correctly today |

## Client

| Format | For | Status | Depends on |
|---|---|---|---|
| **Docker image** | Hosting the web client yourself | ✅ Shipped, single-server mode (`client/Dockerfile`, `API_URL` fixed per deployment via `env-config.js` - see README "Docker images") | — |
| **Docker image, multi-server toggle** | The same image, but letting the people using it pick which home server to log into, rather than it being fixed per deployment | Not started | **Home-server picker** (below) |
| **Desktop app** (Windows/Mac/Linux) | A single-user app, not tied to any one server | Not started | **Home-server picker** (below) + a packaging decision: Tauri (smaller binary, lower memory) vs. Electron (more mature ecosystem) |
| **Mobile apps** (iOS/Android) | Same idea, mobile | Not started | **Home-server picker** (below) + realistically a separate React Native codebase (not a wrapped web view, given the realtime/WebSocket/background-notification work involved) + push notifications (APNs/FCM) |
| **Helm chart** | Hosting the web client on Kubernetes | Not started | The client Docker image (✅ done) - mechanically straightforward once started; the open design question is whether it's its own chart or a subchart of the server's, so a self-hoster can `helm install` one umbrella chart instead of wiring two together by hand |

### The shared blocker: home-server picker

Three of the four remaining client formats above depend on the same thing:
today the client has exactly one API endpoint, fixed at deploy time
(`VITE_API_URL` at build time, or `API_URL` at container start - see
`src/api/client.ts`). A desktop app, a mobile app, and a multi-tenant web
deployment all need the *opposite* - resolving `@user:domain` (or a bare
domain) via `.well-known` at login time, the way `scripts/start-federation-demo.ps1`
already proves the *protocol* supports, and remembering which server a saved
session belongs to.

Practically: building the home-server picker once in the client unlocks the
multi-server Docker toggle, desktop, and mobile at the same time, rather than
being a one-off cost paid by whichever of those three gets built first. It's
already tracked as its own item in `ROADMAP.md` → Client applications; this is
just making the dependency explicit.
