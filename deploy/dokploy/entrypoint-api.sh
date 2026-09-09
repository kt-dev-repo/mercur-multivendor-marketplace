#!/bin/sh
# Runs migrations before the server accepts traffic, then starts Medusa.
# Every medusa call goes through Node — the bun runtime crashes MikroORM's
# decorator metadata lookup on Linux.
set -e

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${REDIS_URL:?REDIS_URL is required}"

MEDUSA=/app/node_modules/.bin/medusa

echo "→ Running migrations"
node "$MEDUSA" db:migrate

# Optional, off by default. Seeding creates demo sellers, products and offers.
# Only ever enable it against a fresh database.
#
# The built server ships COMPILED scripts, so the path is src/scripts/seed.js —
# medusa's own package.json still says seed.ts, which only exists before the
# build. Prefer .js and fall back to .ts so this works either way.
if [ "${RUN_SEED:-false}" = "true" ]; then
  echo "→ Seeding (RUN_SEED=true)"
  if [ -f ./src/scripts/seed.js ]; then
    SEED_SCRIPT=./src/scripts/seed.js
  elif [ -f ./src/scripts/seed.ts ]; then
    SEED_SCRIPT=./src/scripts/seed.ts
  else
    echo "  ERROR: no seed script found under ./src/scripts" >&2
    exit 1
  fi
  # Deliberately fatal. A silently skipped seed produces a storefront with no
  # products and no obvious cause, which is far worse than a failed deploy.
  node "$MEDUSA" exec "$SEED_SCRIPT"
  echo "  seeded via $SEED_SCRIPT"
fi

# Optional first admin user. Creating an existing user fails harmlessly.
if [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  echo "→ Ensuring admin user ${ADMIN_EMAIL}"
  node "$MEDUSA" user -e "$ADMIN_EMAIL" -p "$ADMIN_PASSWORD" || echo "  admin user already exists"
fi

echo "→ Starting Medusa on ${PORT:-9000}"
exec node "$MEDUSA" start
