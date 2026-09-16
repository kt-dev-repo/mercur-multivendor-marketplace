# Reproduction: API 502 — `medusa db:migrate` connection timeout

Stage 3 (tester). Defects are reproduced here, **not** fixed. Nothing in this
document proposes a change.

## Production signature being matched

```
postgres reachable
redis reachable
→ Running migrations
Could not connect to the database while running migrations. The connection timed
out after 30 seconds, which usually indicates an incorrect database URL or an SSL
configuration issue.
```

Server never listens → Traefik returns 502 on every route.

### Where that string comes from

`@medusajs/modules-sdk/dist/medusa-app.js` (the copy `apps/api` resolves, via
`@medusajs/framework@2.20.1+f34aea2dad41b523`):

```js
async function verifyMigrationConnection(knex) {
    const connectionTimeout = getMigrationConnectionTimeout();   // default 10000
    const timeout = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(... `Could not connect to the database while running migrations. The connection timed out after ${connectionTimeout / 1000} seconds, ...`)
        }, connectionTimeout);
    });
    try {
        await Promise.race([knex.raw("SELECT 1"), timeout]);
    }
    catch (error) {
        if (error instanceof MedusaError) { throw error; }
        throw new MedusaError(... `Could not connect to the database while running migrations: ${error?.message ?? error}. This usually indicates ...`);
    }
}
```

Two facts follow, and they are what make this diagnosable:

1. **There are two distinct messages.** The production one is the
   **race-timeout branch**. The other branch interpolates the underlying driver
   error (`... while running migrations: <reason>.`). Any candidate that yields
   a driver error cannot be the production fault.
2. **"30 seconds" pins the config.** The default is 10000 ms.
   `deploy/dokploy/.env.example:57` sets
   `MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=30000`, which is the only way the
   message can read "30 seconds".

So production is the case where `knex.raw("SELECT 1")` **neither resolved nor
rejected for 30 full seconds**. That excludes every fast-failing cause.

## Test harness

The `wait_for()` used below is **extracted verbatim** from the shipping script,
so the preflight under test is byte-identical to production:

```sh
awk '/^wait_for\(\) \{$/,/^\}$/' deploy/dokploy/entrypoint-api.sh > /tmp/repro502/waitfor.lib.sh
```

- `/tmp/repro502/probe.sh` — sources that function, runs it, then runs a real
  authenticated `pg` client against the same URL.
- `/tmp/repro502/verify-race.js` — replicates `verifyMigrationConnection`'s
  `Promise.race` against a real `knex` pool.
- `/tmp/repro502/blackhole.js` — TCP server that accepts and never responds.

Local Postgres: `mercur-postgres` (podman), `postgres:16-alpine`.

---

# Reproduction 1 (PRIMARY) — the preflight is a false reassurance

**CONFIRMED.** `wait_for()` performs only a raw `net.connect` and destroys the
socket on the `connect` event. It never sends a startup packet, never
authenticates, never names a database. In **every** case below it printed
`postgres reachable` while a real client failed.

| # | Scenario | Preflight | Real client | Confirms the gap |
|---|---|---|---|---|
| A0 | correct everything (control) | `postgres reachable` | OK (16ms) | control |
| A1 | wrong password | `postgres reachable` | `28P01 password authentication failed` | **yes** |
| A2 | wrong database name | `postgres reachable` | `3D000 database "nonexistent_db" does not exist` | **yes** |
| A3 | role lacking `CONNECT` | `postgres reachable` | `42501 permission denied for database "mercur"` | **yes** |
| A4 | plain `nc` listener, not Postgres | `postgres reachable` | `Connection terminated unexpectedly` | **yes** |
| A5 | black-hole listener (accepts, never replies) | `postgres reachable` | `timeout expired` after 30004ms | **yes** |
| A6 | `max_connections` exhausted | `postgres reachable` | `53300 sorry, too many clients already` | **yes** |
| B1 | `sslmode=require`, server `ssl=off` | `postgres reachable` | `The server does not support SSL connections` | **yes** |
| B2 | server `hostssl`, URL has no `sslmode` | `postgres reachable` | `28000 no pg_hba.conf entry ... no encryption` | **yes** |
| C2 | severe CPU starvation | `postgres reachable` | migration probe timed out at 30s | **yes** |

Nine distinct broken configurations, nine `postgres reachable`. The preflight's
only true statement is "something is listening on that TCP port".

### Verbatim output

```
$ sh /tmp/repro502/probe.sh "A0 baseline - correct everything" "postgres://mercur:mercur@localhost:5432/mercur"
SCENARIO: A0 baseline - correct everything
--- entrypoint preflight (wait_for, verbatim) ---
  postgres reachable
  PREFLIGHT VERDICT: PASSED
--- real authenticated client ---
  REAL CLIENT: OK (16ms)

$ sh /tmp/repro502/probe.sh "A1 WRONG PASSWORD" "postgres://mercur:totally-wrong-password@localhost:5432/mercur"
--- entrypoint preflight (wait_for, verbatim) ---
  postgres reachable
  PREFLIGHT VERDICT: PASSED
--- real authenticated client ---
  REAL CLIENT: FAILED after 12ms
    name=error code=28P01
    message=password authentication failed for user "mercur"

$ sh /tmp/repro502/probe.sh "A2 WRONG DATABASE NAME" "postgres://mercur:mercur@localhost:5432/nonexistent_db"
--- entrypoint preflight (wait_for, verbatim) ---
  postgres reachable
  PREFLIGHT VERDICT: PASSED
--- real authenticated client ---
  REAL CLIENT: FAILED after 11ms
    name=error code=3D000
    message=database "nonexistent_db" does not exist

$ sh /tmp/repro502/probe.sh "A3 ROLE LACKS CONNECT PRIVILEGE" "postgres://noconnect:noconnect@localhost:5432/mercur"
--- entrypoint preflight (wait_for, verbatim) ---
  postgres reachable
  PREFLIGHT VERDICT: PASSED
--- real authenticated client ---
  REAL CLIENT: FAILED after 16ms
    name=error code=42501
    message=permission denied for database "mercur"

$ sh /tmp/repro502/probe.sh "A4 PLAIN TCP LISTENER, NOT POSTGRES (nc -l 55432)" "postgres://mercur:mercur@localhost:55432/mercur"
--- entrypoint preflight (wait_for, verbatim) ---
  postgres reachable
  PREFLIGHT VERDICT: PASSED
--- real authenticated client ---
  REAL CLIENT: FAILED after 6ms
    name=Error code=(none)
    message=Connection terminated unexpectedly

$ sh /tmp/repro502/probe.sh "A5 BLACK-HOLE LISTENER (accepts, never responds)" "postgres://mercur:mercur@localhost:55433/mercur"
--- entrypoint preflight (wait_for, verbatim) ---
  postgres reachable
  PREFLIGHT VERDICT: PASSED
--- real authenticated client ---
  REAL CLIENT: FAILED after 30004ms
    name=Error code=(none)
    message=timeout expired
```

Setup for A3 (role dropped and `PUBLIC` grant restored afterwards):

```sh
podman exec mercur-postgres psql -U postgres -d mercur \
  -c "CREATE ROLE noconnect LOGIN PASSWORD 'noconnect';" \
  -c "REVOKE CONNECT ON DATABASE mercur FROM noconnect;" \
  -c "REVOKE CONNECT ON DATABASE mercur FROM PUBLIC;"
```

This reproduction is environment-independent and holds regardless of what the
production root cause turns out to be.

---

# Reproduction 2 — root-cause probes

Command form, run from `/tmp/repro502`:

```sh
MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=30000 node /tmp/repro502/verify-race.js "<URL>"
```

| Candidate | Result | Matches production? |
|---|---|---|
| B1 `sslmode=require`, server `ssl=off` | throws in 11ms, driver-error branch | **NO** |
| B2 server demands SSL, URL lacks `sslmode` | throws in 7ms, driver-error branch | **NO** |
| B3 `sslmode=require`, self-signed cert | throws in 21ms, driver-error branch | **NO** |
| B4 `sslmode=no-verify` against SSL server | OK (20ms) | n/a (control) |
| A6 `max_connections` exhausted | throws in 10ms, driver-error branch | **NO** |
| A5b black-hole listener / hung proxy | throws at **30003ms**, race-timeout branch | **YES — exact** |
| C1 severe CPU starvation | throws at **30002ms**, race-timeout branch | **YES — exact** |

### Exact outputs

**B1 — `sslmode=require` demanded by URL, server has `ssl=off`. NOT a match.**
```
  RESULT: THREW after 11ms
  MESSAGE: Could not connect to the database while running migrations: The server does not support SSL connections. This usually indicates an incorrect database URL or an SSL configuration issue.
```

**B2 — server demands SSL (`hostssl` in `pg_hba.conf`), URL has no `sslmode`. NOT a match.**
```
  RESULT: THREW after 7ms
  MESSAGE: Could not connect to the database while running migrations: no pg_hba.conf entry for host "10.89.4.5", user "mercur", database "mercur", no encryption. This usually indicates an incorrect database URL or an SSL configuration issue.
```

**B3 — `sslmode=require` against a self-signed cert. NOT a match.**
```
  RESULT: THREW after 21ms
  MESSAGE: Could not connect to the database while running migrations: self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca. This usually indicates an incorrect database URL or an SSL configuration issue.
```

**A6 — `max_connections` exhausted. NOT a match.**
Setup: `ALTER SYSTEM SET max_connections = 10`, restart, then hold every slot.
```
  RESULT: THREW after 10ms
  MESSAGE: Could not connect to the database while running migrations: sorry, too many clients already. This usually indicates an incorrect database URL or an SSL configuration issue.
```
Server-side exhaustion is **rejected instantly** by Postgres with `53300`. It
cannot produce a 30-second silence. This candidate is eliminated.

**A5b — black-hole listener (TCP accepts, handshake never completes). EXACT MATCH.**
```
$ MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=30000 node /tmp/repro502/verify-race.js "postgres://mercur:mercur@localhost:55433/mercur"
  RESULT: THREW after 30003ms
  MESSAGE: Could not connect to the database while running migrations. The connection timed out after 30 seconds, which usually indicates an incorrect database URL or an SSL configuration issue.
```

**C1 — severe CPU starvation. EXACT MATCH.**
Setup: cap the Postgres container at 0.01 CPU and pile on concurrent load.
```sh
podman update --cpus 0.01 mercur-postgres
for i in $(seq 1 14); do
  podman exec -d mercur-postgres psql -U postgres -d mercur \
    -c "select count(*) from generate_series(1,400000000)"
done
```
Dose-response, same probe, increasing starvation:
```
0.01 CPU, no load          ->  RESULT: OK (854ms)
0.01 CPU, 6 burners        ->  RESULT: OK (8075ms)          # already past the 10s DEFAULT threshold territory
0.01 CPU, 20 burners       ->  RESULT: THREW after 30002ms
  MESSAGE: Could not connect to the database while running migrations. The connection timed out after 30 seconds, which usually indicates an incorrect database URL or an SSL configuration issue.
```
And the preflight under that same starvation still passes:
```
### C2 preflight under severe CPU starvation ###
  postgres reachable
  PREFLIGHT VERDICT: PASSED
```

### Real `medusa db:migrate`, not just the replica

**Wrong password, through the real binary** — immediate, distinct, *not* the
production signature:
```sh
cd apps/api && MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=30000 \
  DATABASE_URL="postgres://mercur:totally-wrong-password@localhost:5432/mercur" \
  REDIS_URL="redis://localhost:6379" node ./node_modules/.bin/medusa db:migrate
```
```
  length: 102,
  severity: 'FATAL',
  code: '28P01',
  file: 'auth.c',
  line: '331',
  routine: 'auth_failed'
```

**Black-hole listener, through the real binary** — the CLI's own pool probe
fails *before* `verifyMigrationConnection` is reached, so the wording differs
from production:
```sh
cd apps/api && DATABASE_URL="postgres://mercur:mercur@localhost:55433/mercur" \
  REDIS_URL="redis://localhost:6379" node ./node_modules/.bin/medusa db:migrate
```
```
warn:    Pg connection failed to connect to the database. Retrying...
(pool reported: Knex: Timeout acquiring a connection. The pool is probably full. Are you missing a .transacting(trx) call?)
   ... repeated 4x ...
Error: timeout expired
    at Timeout._onTimeout (node_modules/.bun/pg@8.21.0.../pg/lib/client.js:163:28)
```
This matters: production did **not** print those `Pg connection failed ...
Retrying` lines. The CLI's own probe **succeeded** in production. So in
production, Postgres accepted and authenticated a connection — and then
`SELECT 1` went silent for 30 seconds. That narrows the fault to something that
stalls *after* a connection is established, not a wrong URL and not an
unreachable host.

---

## Conclusions

1. **The preflight defect is confirmed and unconditional.** `wait_for()` reports
   `postgres reachable` for nine distinct broken configurations, including a
   listener that is not Postgres at all. It cannot detect any of them.
2. **The production message is the race-timeout branch**, which requires 30
   seconds of complete silence from `SELECT 1`.
3. **Eliminated** (all fail fast, and all produce the *other*, reason-carrying
   message): wrong password, wrong database, missing `CONNECT`, every SSL
   mismatch in both directions, self-signed certificates, and server-side
   `max_connections` exhaustion.
4. **Consistent with production**: anything that accepts the connection and then
   stalls — a hung/black-holing connection proxy, or severe CPU starvation. Both
   reproduce the production string character-for-character. The absence of the
   CLI's `Pg connection failed ... Retrying` lines in the production log favours
   the starvation/stall class over a misrouted host.

## What could NOT be tested locally, and why

- **pgbouncer in transaction mode.** No pgbouncer image was deployed here. The
  black-hole listener (A5/A5b) emulates the *symptom* a saturated or hung
  transaction-mode pooler produces — TCP accepted, handshake never completing —
  but it is an emulation, not pgbouncer itself. Whether the production stack
  actually has a pooler in front of Postgres is **not established by this
  document** and must be checked against the Dokploy topology.
- **The production Dokploy host itself.** All CPU-starvation numbers come from a
  podman container on macOS throttled to 0.01 CPU. They prove starvation *can*
  produce the exact message; they do not prove the 3 vCPU production host was
  starved at the failing moment. Confirming that needs host metrics from the
  deploy window.
- **Production SSL posture.** `deploy/` sets no `sslmode` anywhere. Whether the
  production database demands SSL was not verifiable from this workspace. Note
  this is largely moot: both SSL directions were tested and **neither** produces
  the production signature.
- **The real `medusa db:migrate` reaching `verifyMigrationConnection`.** Locally
  the CLI's own pool probe fails first, so the exact production wording could not
  be produced through the real binary — only through the faithful
  `verify-race.js` replica of that function. This is a known local limitation
  (see `CLAUDE.local.md`: the migration probe does not complete under podman on
  macOS).

## Environment restoration

All mutations were reverted and verified:

```
REAL CLIENT: OK (13ms)          # baseline latency restored (was 526ms while capped)
max_connections = 100           # reset
ssl = off                       # reset, pg_hba.conf restored from backup
quota = 0                       # CPU cap cleared by recreating the container
role "noconnect"                # dropped; CONNECT re-granted to PUBLIC
seller = 5, product = 53        # seed data intact
```
