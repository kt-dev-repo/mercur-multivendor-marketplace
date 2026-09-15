#!/bin/sh
# Runs migrations before the server accepts traffic, then starts Medusa.
# Every medusa call goes through Node — the bun runtime crashes MikroORM's
# decorator metadata lookup on Linux.
set -e

# Preflight. Report EVERY missing variable at once, and say where to set it.
#
# The bare `${VAR:?msg}` form this replaced died on the first missing variable
# with a one-line dash error and exit 2, which under Dokploy (Swarm) becomes a
# silent crash-loop: "Exited (2)" over and over with no indication of whether the
# value was wrong, empty, or never injected at all.
#
# The visible-names dump below is the diagnosis. If DATABASE_URL is absent from
# it, the Environment tab never reached this container (unsaved, or saved without
# a redeploy) — that is a Dokploy wiring problem, not a database problem. If it
# IS listed, the value is empty and the entry is malformed.
missing=""
for var in DATABASE_URL REDIS_URL; do
  eval "value=\$$var"
  [ -n "$value" ] || missing="$missing $var"
done

if [ -n "$missing" ]; then
  echo >&2 ""
  echo >&2 "=============================================================="
  echo >&2 " Cannot start: required environment variable(s) not set"
  echo >&2 "=============================================================="
  for var in $missing; do
    echo >&2 "  MISSING: $var"
  done
  echo >&2 ""
  echo >&2 " Set these in Dokploy on the API application:"
  echo >&2 "   Application -> Environment -> paste, SAVE, then Redeploy."
  echo >&2 "   Saving alone does not restart the container."
  echo >&2 ""
  echo >&2 "   DATABASE_URL=postgres://USER:PASS@INTERNAL-HOST:5432/DB"
  echo >&2 "   REDIS_URL=redis://INTERNAL-HOST:6379"
  echo >&2 ""
  echo >&2 " The host must be the database service INTERNAL hostname, taken from"
  echo >&2 " its own Dokploy page. NOT localhost — inside this container that means"
  echo >&2 " this container. See deploy/dokploy/env/api.env.example."
  echo >&2 ""
  echo >&2 " Environment variable NAMES visible to this container (values hidden):"
  # Names only. Values would put DATABASE_URL credentials in the log, which
  # Dokploy renders in the browser and keeps.
  env | cut -d= -f1 | sort | sed 's/^/   /' >&2
  echo >&2 ""
  echo >&2 " If the names above do not include the ones marked MISSING, the"
  echo >&2 " Environment tab is not reaching this container at all."
  echo >&2 "=============================================================="
  echo >&2 ""
  exit 1
fi

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
