# Build context is the repo root (`docker build -f client/Dockerfile .`), not
# this directory - npm workspaces monorepo, same reasoning as server/Dockerfile.

# --platform=$BUILDPLATFORM pins deps/build to the runner's own arch even in
# a multi-arch (amd64+arm64) buildx run - the build output is static
# JS/CSS/HTML, identical regardless of target arch, so there's no reason to
# run `vite build` under QEMU emulation at all. This isn't just an
# optimization: esbuild/rollup's native binaries are known to hang
# indefinitely under GitHub Actions' QEMU user-mode emulation (a real
# incident here - the arm64 leg of this build hung for over an hour in CI
# before this fix, despite building fine in well under a minute locally).
# Only the trivial final nginx stage below actually varies per target arch.
FROM --platform=$BUILDPLATFORM node:22-alpine AS base
WORKDIR /app

# ---- deps: full install (all workspaces, including dev deps) for building ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci

# ---- build: vite build ----
FROM deps AS build
COPY client/ client/
# Baked in only as a fallback for anyone running this build output *without*
# the Docker image's runtime env-config.js mechanism (see
# client/docker-entrypoint.sh and src/api/client.ts) - left unset here
# deliberately, so the image always relies on the runtime API_URL instead of
# a value frozen in at build time.
RUN npm run build --workspace client

# ---- runtime: nginx serving the static build, running as non-root ----
FROM nginx:1.27-alpine AS runtime

COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY client/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
COPY --from=build /app/client/dist /usr/share/nginx/html

# The official nginx image's entrypoint already runs every executable script
# in /docker-entrypoint.d/ before starting nginx - 40-runtime-config.sh
# (copied above) generates env-config.js that way, no separate ENTRYPOINT
# override needed. Just needs to be executable and to run as the existing
# unprivileged `nginx` user, which (on this image) already owns everything
# under /usr/share/nginx/html and /var/cache/nginx; only the pid file
# location needs redirecting, since the default (/var/run/nginx.pid) isn't
# writable by a non-root user.
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh \
  && sed -i 's#/run/nginx.pid#/tmp/nginx.pid#' /etc/nginx/nginx.conf \
  && touch /tmp/nginx.pid \
  && chown -R nginx:nginx /tmp/nginx.pid /usr/share/nginx/html /var/cache/nginx

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O- http://localhost:8080/ > /dev/null || exit 1
