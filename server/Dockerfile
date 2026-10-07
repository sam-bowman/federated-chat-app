# Build context is the repo root (`docker build -f server/Dockerfile .`), not
# this directory - this is an npm workspaces monorepo, so the root
# package-lock.json and both workspaces' package.json files are needed for a
# correct `npm ci`.

FROM node:22-alpine AS base
WORKDIR /app
# Prisma's CLI (migration engine) and @prisma/client (query engine) each do
# their own OpenSSL-version auto-detection by shelling out to `openssl` -
# Alpine doesn't ship that binary by default, so without it Prisma silently
# falls back to the wrong engine build and fails at runtime with an opaque
# "Could not parse schema engine response" error, not an obviously
# OpenSSL-related one.
RUN apk add --no-cache openssl

# ---- deps: full install (all workspaces, including dev deps) for building ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci

# ---- build: compile TypeScript ----
FROM deps AS build
COPY server/ server/
RUN npx prisma generate --schema server/prisma/schema.prisma
RUN npm run build --workspace server

# ---- prod-deps: production-only install, server workspace only ----
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci --omit=dev --workspace server
# @prisma/client's generated query engine is tied to the environment it's
# generated in - generating it here (not copying from the `build` stage,
# which uses the same base image but a different, dev-dependency-inclusive
# node_modules tree) keeps it consistent with exactly the node_modules this
# image ships.
COPY server/prisma server/prisma
RUN npx prisma generate --schema server/prisma/schema.prisma

# ---- runtime: minimal final image ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# See the comment on the `base` stage - needed here too since `prisma
# migrate deploy` runs in this image at container startup, not just at
# build time.
RUN apk add --no-cache openssl && addgroup -S app && adduser -S app -G app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY server/prisma ./prisma
COPY server/package.json ./package.json
COPY server/docker-entrypoint.sh ./docker-entrypoint.sh
# UPLOADS_DIR (default "uploads", see src/config.ts) is resolved relative to
# the process cwd - this is where locally-stored message attachments/avatars
# land. Mount a volume here to persist them across container recreation.
RUN mkdir -p uploads && chmod +x ./docker-entrypoint.sh && chown -R app:app /app
VOLUME ["/app/uploads"]

USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
