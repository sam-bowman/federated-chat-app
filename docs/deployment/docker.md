# Docker images

> Part of the [documentation](../../README.md#documentation).

Docker is one of several ways this is (or will be) packaged - see
[docs/distribution.md](../distribution.md) for the full matrix (native binaries, Helm
charts, desktop/mobile apps) and what each still depends on. Every tagged
release publishes multi-stage, non-root, multi-arch (`linux/amd64` +
`linux/arm64`) Docker images to GHCR:

```bash
docker pull ghcr.io/sam-bowman/federated-chat-app-server:latest
docker pull ghcr.io/sam-bowman/federated-chat-app-client:latest
```

Also tagged by exact version (`:0.2.0`) and minor (`:0.2`) - see
`.github/workflows/publish-images.yml`.

## Self-hosting with docker-compose.selfhost.yml

The easiest way to run both images together with Postgres (and optionally
Redis, for multiple server replicas - see [Running multiple replicas](../scaling.md#running-multiple-replicas)):

```bash
cp .env.selfhost.example .env.selfhost
# edit .env.selfhost - at minimum set SERVER_DOMAIN, the two JWT secrets,
# and the two public URLs; see the comments in that file for what each
# one does and why it's required
docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost up -d
```

Verified for real: a full register/login round-trip against the pulled
images, migrations applying automatically on first start. This is distinct
from the plain `docker-compose.yml` at the repo root, which is dev-only
(Postgres/Redis for `npm run dev` - the app itself runs natively there, not
in a container).

**What it doesn't set up**: TLS and a single public port. The client's
`API_URL` is fetched by the *browser*, not proxied server-side, so both
`CLIENT_PUBLIC_URL` and `SERVER_PUBLIC_URL` in `.env.selfhost` need to be
real, externally-reachable addresses - put a reverse proxy (nginx, Caddy,
Traefik) in front of both services yourself for TLS, since that depends
entirely on your own setup. See the `trust proxy` caveat under "Rate
limiting" in [security.md](../security.md#rate-limiting) if you do.

## Running the images directly

Equivalent to what the compose file above wires together, if you'd rather
run (or orchestrate) the containers yourself:

```bash
docker run -d --name chat-server \
  -e SERVER_DOMAIN=chat.example.com \
  -e DATABASE_URL=postgresql://chat:chat@postgres-host:5432/chat \
  -e JWT_ACCESS_SECRET=<a long random string> \
  -e JWT_REFRESH_SECRET=<a different long random string> \
  -e CORS_ORIGIN=https://chat.example.com \
  -p 4000:4000 \
  -v chat-uploads:/app/uploads \
  ghcr.io/sam-bowman/federated-chat-app-server:latest

docker run -d --name chat-client \
  -e API_URL=https://api.chat.example.com \
  -p 8080:8080 \
  ghcr.io/sam-bowman/federated-chat-app-client:latest
```

**`server/Dockerfile`** runs `prisma migrate deploy` automatically on every
container start (same as `scripts/start.ps1` does for local dev) before
starting the app - nothing to run by hand.

**`client/Dockerfile`** serves the build with nginx, but the API URL a React
SPA talks to is normally baked in at `vite build` time, which would mean
anyone wanting to point the same published image at a different server would
have to rebuild it themselves. Instead, the image generates a small
`env-config.js` from the `API_URL` env var *at container start*
(`client/docker-entrypoint.sh`), and `src/api/client.ts` checks that before
falling back to any build-time value - one built image, runtime-configurable.

Both Dockerfiles build from the **repo root** as context (`docker build -f
server/Dockerfile .`), not their own directory - this is an npm workspaces
monorepo, so the root `package-lock.json` is needed for a correct `npm ci`.
