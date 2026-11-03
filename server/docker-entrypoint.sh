#!/bin/sh
set -e

# Applies any pending migrations before the server starts, so a self-hoster never has to run
# this by hand. Safe to run on every container start: a no-op when nothing's pending, and safe
# when several replicas start at once (the migrator takes a database lock).
#
# This is the server's own migrator (src/migrate.ts), not `prisma migrate deploy`: the image has
# no prisma CLI, which cut node_modules from 390 MB to about 163 MB.
#
# A database that does not exist is REFUSED, because the old `prisma migrate deploy` CREATED it and
# carried on, which turned a typo in the database name at the end of DATABASE_URL into a new, empty
# database with a new federation identity. CREATE_DATABASE_IF_MISSING=true skips the check, and then
# migrate.js makes the database if it is missing.
if [ "$CREATE_DATABASE_IF_MISSING" != "true" ]; then
  node dist/checkDatabaseExists.js
fi

echo "Applying database migrations..."
node dist/migrate.js

exec "$@"
