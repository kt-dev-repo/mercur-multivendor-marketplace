#!/bin/sh
# Runs migrations before the server accepts traffic, then starts Medusa.
# Every medusa call goes through Node — the bun runtime crashes MikroORM's
# decorator metadata lookup on Linux.
set -e

# ---------------------------------------------------------------------------
# Preflight, four phases. Read deploy/dokploy/README.md "Reading the preflight
# report" for what each verdict token means.
#
# This is an INSTRUMENT, not a cure. Its job is to make the next failed boot
# name its own cause from the Dokploy log alone — there is no SSH on that host,
# so the log is the entire observability surface.
#
# Exactly one line per run matches `PREFLIGHT OK` or `PREFLIGHT FAIL: <token>`.
# The tokens are mutually exclusive and greppable; grep for that prefix first.
# ---------------------------------------------------------------------------

echo "[preflight 1/4] environment"

# Report EVERY missing variable at once, and say where to set it.
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
#
# This phase is the ONLY cross-Application startup ordering Dokploy offers, so it
# stays. But it proves strictly one thing: a port is open. It cannot tell a
# healthy Postgres from a routing blackhole, a wrong database, or a bad password
# — it printed "reachable" for nine distinct broken configurations during the
# 2026-09-16 incident. Phases 3 and 4 exist because of that. Never read phase 2
# as evidence the database works.
wait_for() {
  name=$1 url=$2 timeout=${WAIT_TIMEOUT:-120}
  # The URL goes through the environment, never argv: argv is world-readable in
  # /proc/<pid>/cmdline and in `ps`, and this URL carries the password.
  # The ${...} below are JS template literals, not shell expansions.
  # shellcheck disable=SC2016
  WAIT_URL="$url" node -e '
    const net = require("net")
    let parsed
    try {
      parsed = new URL(process.env.WAIT_URL)
    } catch (err) {
      // Node prints `input: "<the whole url>"` when it throws on a bad URL, and
      // that url carries the password. Never let that reach the log.
      console.error(`  name=${err.name} code=${err.code || "ERR_INVALID_URL"} — the URL is unparseable (value withheld)`)
      console.error(`  PREFLIGHT FAIL: driver`)
      process.exit(1)
    }
    const { hostname, port, protocol } = parsed
    const budget = Number(process.argv[1])
    const started = Date.now()
    const deadline = started + budget * 1000
    const fallback = protocol.startsWith("redis") ? 6379 : 5432
    const target = Number(port || fallback)
    let lastCode = "ETIMEDOUT"
    ;(function attempt () {
      const socket = net.connect({ host: hostname, port: target })
      socket.setTimeout(3000)
      socket.on("connect", () => { socket.destroy(); process.exit(0) })
      const retry = (err) => {
        socket.destroy()
        if (err && err.code) lastCode = err.code
        if (Date.now() > deadline) {
          const secs = Math.round((Date.now() - started) / 1000)
          // A name that does not resolve is a different fault from a port that
          // does not answer, and it points at a different fix. Keep them apart.
          const isDns = lastCode === "ENOTFOUND" || lastCode === "EAI_AGAIN"
          console.error(`  host=${hostname} port=${target} code=${lastCode} after ${secs}s (budget ${budget}s)`)
          console.error(`  PREFLIGHT FAIL: ${isDns ? "dns" : "tcp-unreachable"}`)
          process.exit(1)
        }
        setTimeout(attempt, 2000)
      }
      socket.on("error", retry)
      socket.on("timeout", () => retry(null))
    })()
  ' "$timeout" || {
    echo "ERROR: cannot reach $name. With separate Dokploy services, check that" >&2
    echo "  the API and $name share a network and that the host in the URL is the" >&2
    echo "  service's INTERNAL hostname, not localhost." >&2
    exit 1
  }
  # Deliberately NOT "reachable". See the comment above wait_for().
  echo "  $name: tcp port open (not authenticated, not identified as $name)"
}

echo "[preflight 2/4] tcp reachability      (proves: a port is open. NOT that it is Postgres.)"
wait_for postgres "$DATABASE_URL"
wait_for redis    "$REDIS_URL"

# Phases 3 and 4 in ONE node process. Node cold start is the dominant cost on a
# 3-vCPU host, so the wire-protocol probe and the authenticated session share a
# process rather than paying for two.
#
# Phase 3 answers the one question an authenticated probe structurally cannot:
# a TCP blackhole and a stalled TLS handshake both present as a connect() that
# never settles. Writing the 8-byte SSLRequest and reading a single byte
# separates them — 'S'/'N' means something on that port really speaks the
# Postgres wire protocol, and names its TLS posture; no byte at all means it
# does not, which is the single most valuable line this instrument can print.
# Written to a file rather than inlined with `node -e`: a quoted heredoc inside
# a `$(...)` substitution is mis-parsed by bash 3.2 (it scans the body for
# matching parens/quotes), so `sh -n` fails on macOS even though dash is fine.
PREFLIGHT_JS="${TMPDIR:-/tmp}/mercur-preflight.js"
cat > "$PREFLIGHT_JS" <<'PREFLIGHT_EOF'
const net = require("net")
const dns = require("dns")

const RAW_URL = process.env.DATABASE_URL || ""
const WAIT_TIMEOUT = Number(process.env.WAIT_TIMEOUT || 120)
const BUDGET_MS = Math.max(5, WAIT_TIMEOUT) * 1000
const PROTO_TIMEOUT_MS = 10000
const SESSION_TIMEOUT_MS = 10000
const RETRY_DELAY_MS = 2000
const startedAt = Date.now()
const remaining = () => BUDGET_MS - (Date.now() - startedAt)

// Redaction. Dokploy renders these logs in a browser and retains them, so the
// password must never survive a line — in either the form the URL carries it
// (percent-encoded) or the form the driver reports it (decoded).
const secrets = []
const addSecret = (s) => {
  if (typeof s === "string" && s.length > 0 && !secrets.includes(s)) secrets.push(s)
}
const scrub = (text) => {
  let out = String(text)
  for (const s of secrets) out = out.split(s).join("***")
  return out
}
const say = (line) => { console.log(scrub(line)) }
const fail = (token, ...lines) => {
  for (const line of lines) say("  " + line)
  say("  PREFLIGHT FAIL: " + token)
  process.exitCode = 1
  // A hung socket must never outlive the verdict.
  process.exit(1)
}

let url
try {
  url = new URL(RAW_URL)
} catch (err) {
  // Neither RAW_URL nor err.input is echoed: a malformed URL is still a URL with
  // a password in it, and node puts the whole input on the error object.
  fail("driver", "DATABASE_URL is not a parseable URL"
    + " (name=" + err.name + " code=" + (err.code || "ERR_INVALID_URL") + ", value withheld)")
}

const rawUser = url.username
const rawPassword = url.password
addSecret(rawPassword)
let user = rawUser
let password = rawPassword
try {
  user = decodeURIComponent(rawUser)
  password = decodeURIComponent(rawPassword)
  addSecret(password)
  addSecret(encodeURIComponent(password))
} catch {
  // Not percent-encoded. The raw forms are already registered as secrets.
  say("  note: credentials are not valid percent-encoding; using them verbatim")
}

const host = url.hostname
const port = Number(url.port || 5432)
let database = url.pathname.replace(/^\//, "")
try {
  database = decodeURIComponent(database)
} catch {
  // Not percent-encoded; the raw path segment is the database name.
  say("  note: database name is not valid percent-encoding; using it verbatim")
}
const sslmode = url.searchParams.get("sslmode") || url.searchParams.get("ssl") || "none"

say("[preflight 3/4] postgres wire protocol")
say("  host=" + host)
say("  port=" + port)
say("  database=" + (database || "<empty>"))
say("  user=" + (user || "<empty>"))
say("  password=" + (password ? "set" : "EMPTY"))
say("  sslmode=" + sslmode)
say("  budget=" + Math.round(BUDGET_MS / 1000) + "s for phases 3+4; worst case boot is"
  + " 2 x WAIT_TIMEOUT = " + (2 * WAIT_TIMEOUT) + "s before this container exits non-zero")

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const resolveHost = () => new Promise((resolve) => {
  const t0 = Date.now()
  dns.lookup(host, { all: true }, (err, addresses) => {
    if (err) {
      resolve({ ok: false, code: err.code || "UNKNOWN", ms: Date.now() - t0 })
      return
    }
    resolve({ ok: true, ms: Date.now() - t0, ips: addresses.map((a) => a.address).join(",") })
  })
})

// Write SSLRequest (length 8, request code 80877103 = 0x04D2162F) and read one
// byte. This is the whole discriminator between C1 and C3.
const probeWire = () => new Promise((resolve) => {
  const t0 = Date.now()
  let connectedMs = null
  let settled = false
  const socket = net.connect({ host, port })
  const done = (result) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    socket.destroy()
    resolve(result)
  }
  const timer = setTimeout(() => {
    done({ kind: connectedMs === null ? "tcp-timeout" : "no-reply", connectedMs, waitedMs: Date.now() - t0 })
  }, Math.max(1000, Math.min(PROTO_TIMEOUT_MS, remaining())))
  socket.on("connect", () => {
    connectedMs = Date.now() - t0
    const packet = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f])
    socket.write(packet)
  })
  socket.on("data", (chunk) => {
    if (chunk.length === 0) return
    done({ kind: "reply", connectedMs, byte: String.fromCharCode(chunk[0]), replyMs: Date.now() - t0 })
  })
  socket.on("close", () => {
    done({ kind: "closed", connectedMs, closedAfterMs: Date.now() - t0 })
  })
  socket.on("error", (err) => {
    done({ kind: "error", connectedMs, code: err.code || "UNKNOWN", message: err.message, ms: Date.now() - t0 })
  })
})

// This file is written to a temp dir, so a bare require("pg") resolves from
// /tmp, not from the app root. The cwd and /app candidates are what actually
// find the driver; the bare specifier is kept first for the case where the
// probe ever runs from inside the app tree.
const loadPg = () => {
  const path = require("path")
  const candidates = ["pg", path.join(process.cwd(), "node_modules", "pg"), "/app/node_modules/pg"]
  const tried = []
  for (const candidate of candidates) {
    try {
      tried.push(candidate)
      return { ok: true, pg: require(candidate) }
    } catch (err) {
      tried[tried.length - 1] = candidate + " (" + (err.code || err.name) + ")"
    }
  }
  return { ok: false, tried }
}

const openSession = (pg) => new Promise((resolve) => {
  const t0 = Date.now()
  const client = new pg.Client({
    connectionString: RAW_URL,
    connectionTimeoutMillis: Math.max(1000, Math.min(SESSION_TIMEOUT_MS, remaining())),
    query_timeout: Math.max(1000, Math.min(SESSION_TIMEOUT_MS, remaining())),
    application_name: "mercur-preflight",
  })
  client.connect()
    .then(async () => {
      const connectMs = Date.now() - t0
      const t1 = Date.now()
      await client.query("SELECT 1")
      const select1Ms = Date.now() - t1
      let facts = null
      let factsError = null
      try {
        const res = await client.query(
          "SELECT current_setting('server_version_num') AS version,"
          + " current_setting('max_connections') AS max_connections,"
          + " (SELECT count(*) FROM pg_stat_activity)::text AS backends"
        )
        facts = res.rows[0]
      } catch (err) {
        factsError = (err && err.code ? err.code + " " : "") + (err && err.message ? err.message : String(err))
      }
      // A failed close carries no diagnosis; the session already succeeded.
      await client.end().catch(() => {})
      resolve({ ok: true, connectMs, select1Ms, facts, factsError })
    })
    .catch(async (err) => {
      // The connect error below is the diagnosis; a close error on top of it is not.
      await client.end().catch(() => {})
      resolve({
        ok: false,
        ms: Date.now() - t0,
        code: err && err.code ? err.code : "",
        name: err && err.name ? err.name : "Error",
        severity: err && err.severity ? err.severity : "",
        message: err && err.message ? err.message : String(err),
      })
    })
})

// Mutually exclusive by construction: the first matching rule wins and returns.
const classify = (err) => {
  const code = err.code || ""
  const message = err.message || ""
  const looksTls = /\bssl\b|\btls\b|certificate|self-signed|no encryption/i.test(message)
  if (code === "3D000") return "database-missing"
  if (code === "53300") return "server-connection-limit"
  if (code === "28P01") return "auth"
  // 28000 covers both "no pg_hba.conf entry ... no encryption" (a TLS posture
  // mismatch) and genuine authorisation refusals. Reporting the former as
  // "auth" would send the reader after credentials that are correct.
  if (code === "28000") return looksTls ? "tls" : "auth"
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns"
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return "tcp-unreachable"
  if (!code && looksTls) return "tls"
  // The driver's own connectionTimeoutMillis fired: the wire probe already
  // proved a Postgres speaker is there, so this is a queueing pooler or a
  // stalled backend, not an unreachable host.
  if (!code && /timeout expired|Connection terminated (unexpectedly|due to connection timeout)/i.test(message)) {
    return "auth-stall"
  }
  return "driver"
}

// Retried only where a retry can plausibly change the answer. A wrong password
// or a missing database will not fix itself, and burning the whole budget on it
// delays the operator's diagnosis for nothing.
const RETRYABLE = ["dns", "tcp-unreachable", "no-postgres-protocol-response", "protocol-reset", "auth-stall", "server-connection-limit"]

const run = async () => {
  const driver = loadPg()
  if (!driver.ok) {
    fail("pg-driver-unavailable",
      "tried: " + driver.tried.join(", "),
      "cwd=" + process.cwd(),
      "this is a build defect, not a database problem: Dockerfile.api asserts pg resolves")
  }

  let attempt = 0
  let retryNoted = false
  // Retries are counted, not narrated: a full budget of per-attempt lines would
  // blow the report past the point where a human reads it.
  const retrying = (why) => {
    if (!retryNoted) {
      retryNoted = true
      say("  " + why + " — retrying until the budget is spent (further attempts are silent)")
    }
  }
  const attempts = () => "attempts=" + attempt + " over " + Math.round((Date.now() - startedAt) / 1000) + "s"

  for (;;) {
    attempt += 1
    const isRetry = attempt > 1

    const lookup = await resolveHost()
    if (!lookup.ok) {
      if (remaining() > RETRY_DELAY_MS + 2000) {
        retrying("dns=FAILED code=" + lookup.code)
        await sleep(RETRY_DELAY_MS)
        continue
      }
      fail("dns", "host=" + host, "code=" + lookup.code, "dns=FAILED after " + lookup.ms + "ms, " + attempts())
    }
    if (!isRetry) say("  dns=" + lookup.ips + " in " + lookup.ms + "ms")

    const wire = await probeWire()
    let verdict = null
    let evidence = []

    if (wire.kind === "error" && wire.connectedMs === null) {
      verdict = classify({ code: wire.code, message: wire.message })
      if (verdict !== "tcp-unreachable" && verdict !== "dns") verdict = "tcp-unreachable"
      evidence = ["host=" + host + " port=" + port, "code=" + wire.code, "tcp failed after " + wire.ms + "ms"]
    } else if (wire.kind === "tcp-timeout") {
      verdict = "tcp-unreachable"
      evidence = ["host=" + host + " port=" + port, "tcp connect did not complete within " + Math.round(wire.waitedMs / 1000) + "s"]
    } else if (wire.kind === "no-reply") {
      verdict = "no-postgres-protocol-response"
      evidence = [
        "tcp_connect_ms=" + wire.connectedMs,
        "protocol_reply=none",
        "no reply to SSLRequest within " + Math.round(wire.waitedMs / 1000) + "s, socket still open",
        "the port is open but nothing on it speaks the postgres wire protocol:",
        "suspect a routing/ingress VIP, a stale service alias, or a hung proxy in front of postgres",
      ]
    } else if (wire.kind === "closed" || (wire.kind === "error" && wire.connectedMs !== null)) {
      verdict = "protocol-reset"
      evidence = [
        "tcp_connect_ms=" + wire.connectedMs,
        "protocol_reply=none",
        wire.kind === "error"
          ? "code=" + wire.code + " after " + wire.ms + "ms"
          : "closed after " + wire.closedAfterMs + "ms without a protocol byte",
        "something accepted the connection and hung up instead of answering SSLRequest",
      ]
    }

    if (verdict) {
      if (RETRYABLE.includes(verdict) && remaining() > RETRY_DELAY_MS + PROTO_TIMEOUT_MS) {
        retrying(verdict)
        await sleep(RETRY_DELAY_MS)
        continue
      }
      fail(verdict, ...evidence, attempts())
    }

    say("  tcp_connect_ms=" + wire.connectedMs)
    say("  protocol_reply=" + wire.byte + " (at " + wire.replyMs + "ms; the port speaks postgres"
      + (wire.byte === "S" ? " and offers TLS)" : wire.byte === "N" ? " and refuses TLS)" : ")"))

    if (wire.byte !== "S" && wire.byte !== "N") {
      fail("driver", "unexpected SSLRequest reply byte " + JSON.stringify(wire.byte))
    }
    if (wire.byte === "N" && /^(require|verify-ca|verify-full|true)$/i.test(sslmode)) {
      fail("tls",
        "sslmode=" + sslmode + " but protocol_reply=N",
        "the server refuses TLS and the URL demands it: drop sslmode, or enable TLS on the server")
    }

    say("[preflight 4/4] authenticated session")
    const session = await openSession(driver.pg)
    if (!session.ok) {
      const token = classify(session)
      const detail = [
        "code=" + (session.code || "(none)") + " name=" + session.name
          + (session.severity ? " severity=" + session.severity : ""),
        session.message,
      ]
      if (token === "auth-stall") {
        detail.unshift("protocol_reply=" + wire.byte + " received at " + wire.replyMs + "ms,"
          + " then no session within " + Math.round(session.ms / 1000) + "s")
        detail.push("postgres answered the wire probe but never completed a session:"
          + " suspect a transaction-pooling proxy queueing, or a stalled backend")
      }
      if (token === "tls") detail.unshift("sslmode=" + sslmode + " protocol_reply=" + wire.byte)
      if (RETRYABLE.includes(token) && remaining() > RETRY_DELAY_MS + SESSION_TIMEOUT_MS) {
        retrying(token + ": " + scrub(session.message))
        await sleep(RETRY_DELAY_MS)
        continue
      }
      fail(token, ...detail, attempts())
    }

    say("  connect_ms=" + session.connectMs)
    say("  select1_ms=" + session.select1Ms)
    if (session.facts) {
      say("  server_version=" + session.facts.version)
      say("  backends=" + session.facts.backends + "/" + session.facts.max_connections)
    } else {
      say("  server_version=unknown")
      say("  backends=unknown/unknown (" + session.factsError + ")")
    }
    say("  PREFLIGHT OK")
    // Without this sentence PREFLIGHT OK becomes the new "postgres reachable".
    // The probe uses ONE pg client, so knex's pool is never exercised and this
    // result cannot exonerate pool starvation or a blocked event loop.
    say("  database reachable and authenticated at this instant, over a single client —"
      + " knex's POOL was NOT exercised. If medusa db:migrate still reports a connection"
      + " timeout after this line, the stall is client-side (knex pool acquisition or a"
      + " blocked event loop), NOT reachability. Do not re-investigate the network.")
    return
  }
}

run().catch((err) => {
  // An unhandled rejection here would exit 1 with a stack trace that can carry
  // the connection string. Scrub it, print only what identifies the fault.
  fail("driver", "unexpected preflight error: " + (err && err.name ? err.name : "Error")
    + " " + (err && err.message ? err.message : String(err)))
})
PREFLIGHT_EOF

# `if` keeps this set -e-safe: a non-zero probe must never kill the script
# before its own diagnosis has been printed and flushed. DATABASE_URL reaches
# the probe through the environment only — never argv (G8).
if node "$PREFLIGHT_JS"; then
  rm -f "$PREFLIGHT_JS"
else
  rm -f "$PREFLIGHT_JS"
  echo "  preflight failed — see the PREFLIGHT FAIL token above." >&2
  echo "  Token meanings: deploy/dokploy/README.md, 'Reading the preflight report'." >&2
  exit 1
fi

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
