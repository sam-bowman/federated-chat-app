# Build context is the repo root (`docker build -f server/Dockerfile .`), not
# this directory - this is an npm workspaces monorepo, so the root
# package-lock.json and both workspaces' package.json files are needed for a
# correct `npm ci`.

# Base images are pinned by digest (the tag says which release line to follow, the digest which build it is), so a rebuild takes exactly
# the image that was looked at and a moved tag cannot change it. Dependabot's docker updater moves both together (weekly, one pull
# request for all base images); OpenSSF Scorecard's Pinned-Dependencies check looks for this.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base
WORKDIR /app

# ---- deps: full install (all workspaces, including dev deps) for building ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci

# ---- build: compile TypeScript ----
FROM deps AS build
COPY server/ server/
# Writes the client's TypeScript into server/src/generated (schema.prisma's `output`), which the build below compiles into dist/.
RUN npm run prisma:generate --workspace server
RUN npm run build --workspace server

# ---- prod-deps: production-only install, server workspace only ----
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
# --omit=optional as well as --omit=dev, because of the `prisma` CLI. It is a devDependency, but @prisma/client lists it as an OPTIONAL peer, so npm keeps it
# in a production install ("devOptional") together with everything it needs for Studio and its dev server: node_modules went from about 119 MB to 373 MB. The
# server does not run it (src/migrate.ts migrates), so it has no place here. The price: no optional dependency of any package is installed, which today is
# only platform binaries and tooling; the check below fails the build if the CLI comes back, and the image scan job starts the image for real.
RUN npm ci --omit=dev --omit=optional --workspace server \
  && test ! -e node_modules/prisma && test ! -e node_modules/@prisma/studio-core

# ---- runtime: minimal final image ----
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# `apk upgrade` takes the operating-system fixes released since the base image was built (an image
# scan finds the rest of them; see docs/security.md), so a rebuild is enough to pick them up. The
# price is that two builds of the same commit on different days are not byte for byte the same.
# npm is removed: nothing here runs it (the entrypoint and the health check call node), and its own
# bundled packages are the ones scanners keep flagging. No openssl either: it was only for the prisma CLI's
# migration engine, which is gone.
RUN apk upgrade --no-cache \
  && addgroup -S app && adduser -S app -G app \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Everything is owned by the app user as it is copied. A `chown -R app:app /app` afterwards would write the whole of node_modules again into a new
# layer, which is the biggest single part of what the image weighs.
COPY --chown=app:app --from=prod-deps /app/node_modules ./node_modules
COPY --chown=app:app --from=build /app/server/dist ./dist
# Only the migrations: the entrypoint runs the server's own migrator (dist/migrate.js) over them. There is no `prisma` CLI in this image (it brought
# Studio and a dev server along, which took node_modules from about 163 MB to 390 MB), so no schema.prisma or prisma.config.ts is needed either.
COPY --chown=app:app server/prisma/migrations ./prisma/migrations
COPY --chown=app:app server/package.json ./package.json
COPY --chown=app:app --chmod=755 server/docker-entrypoint.sh ./docker-entrypoint.sh
# UPLOADS_DIR (default "uploads", see src/config.ts) is resolved relative to
# the process cwd - this is where locally-stored message attachments/avatars
# land. Mount a volume here to persist them across container recreation.
RUN mkdir -p uploads && chown app:app /app uploads
VOLUME ["/app/uploads"]

USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
