#!/bin/sh
set -e

# Applies any pending migrations before the server starts - the same thing
# scripts/start.ps1 does for local dev, so a self-hoster never has to run
# this by hand. Safe to run on every container start: a no-op when nothing's
# pending.
echo "Applying database migrations..."
node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma

exec "$@"
