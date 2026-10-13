#!/bin/sh
set -e

# Applies any pending migrations before the server starts - the same thing
# scripts/start.ps1 does for local dev, so a self-hoster never has to run
# this by hand. Safe to run on every container start: a no-op when nothing's
# pending.
# `prisma migrate deploy` CREATES a database that does not exist and carries on, which turned a
# typo in the database name into a new, empty database. Refuse instead, like the native
# binaries do; CREATE_DATABASE_IF_MISSING=true keeps the old behaviour.
if [ "$CREATE_DATABASE_IF_MISSING" != "true" ]; then
  node dist/checkDatabaseExists.js
fi

echo "Applying database migrations..."
node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma

exec "$@"
