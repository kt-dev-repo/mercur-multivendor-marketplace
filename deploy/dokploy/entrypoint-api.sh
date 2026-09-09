#!/bin/sh
# Runs migrations before the server accepts traffic, then starts Medusa.
# Every medusa call goes through Node — the bun runtime crashes MikroORM's
# decorator metadata lookup on Linux.
set -e

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${REDIS_URL:?REDIS_URL is required}"

MEDUSA=/app/node_modules/.bin/medusa

# Wait for Postgres and Redis before touching them.
#
# When they run as SEPARATE Dokploy services, compose `depends_on` cannot span
# projects, so there is no ordering guarantee at all — the API may start while
# the database is still booting, or seconds before the shared network is ready.
# Without this the container dies on a raw connection error and crash-loops with
# a message that looks like a credentials problem rather than a timing one.
wait_for() {
  name=$1 url=$2 timeout=${WAIT_TIMEOUT:-120}
  node -e '
    const { hostname, port, protocol } = new URL(process.argv[1])
    const net = require("net")
    const deadline = Date.now() + Number(process.argv[2]) * 1000
    const fallback = protocol.startsWith("redis") ? 6379 : 5432
    const target = Number(port || fallback)
    ;(function attempt () {
      const socket = net.connect({ host: hostname, port: target })
      socket.setTimeout(3000)
      socket.on("connect", () => { socket.destroy(); process.exit(0) })
      const retry = () => {
        socket.destroy()
        if (Date.now() > deadline) {
          console.error(`  unreachable after ${process.argv[2]}s: ${hostname}:${target}`)
          process.exit(1)
        }
        setTimeout(attempt, 2000)
      }
      socket.on("error", retry)
      socket.on("timeout", retry)
    })()
  ' "$url" "$timeout" || {
    echo "ERROR: cannot reach $name. With separate Dokploy services, check that" >&2
    echo "  the API and $name share a network and that the host in the URL is the" >&2
    echo "  service's INTERNAL hostname, not localhost." >&2
    exit 1
  }
  echo "  $name reachable"
}

echo "→ Waiting for dependencies"
wait_for postgres "$DATABASE_URL"
wait_for redis    "$REDIS_URL"

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
