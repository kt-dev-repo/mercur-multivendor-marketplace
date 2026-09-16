# FIX-PLAN — api.nokor24.com 502: migration connection timeout

Stage 1 (PO) work order. Scope and decisions only — no code in this document.
Downstream: mercur-qc → mercur-tester → mercur-dev.

**Cycle goal:** make the next failed API deploy self-diagnosing from the Dokploy
log alone, and on that evidence eliminate the cause of the migration-connection
timeout that is keeping the API from ever listening.

---

## The one finding that re-ranks everything

The failure message is produced by the **timeout branch**, not the error branch,
of Medusa's pre-migration probe
(`@medusajs/modules-sdk/dist/medusa-app.js`, `verifyMigrationConnection`):

```js
const timeout = new Promise((_, reject) => {
  timeoutHandle = setTimeout(() => {
    reject(new MedusaError(DB_ERROR, `Could not connect to the database while running
      migrations. The connection timed out after ${connectionTimeout / 1000} seconds,
      which usually indicates an incorrect database URL or an SSL configuration issue.`))
  }, connectionTimeout)
})
await Promise.race([knex.raw("SELECT 1"), timeout])
```

The other branch — `Could not connect to the database while running migrations: <driver
message>` — is what a *rejected* connection produces. Our log shows the timer text.

Therefore `knex.raw("SELECT 1")` **neither resolved nor rejected in 30 s**. Every
cause that makes Postgres answer *fast and negatively* is ruled out by the shape
of the message before any further investigation:

- wrong password / wrong role → `password authentication failed` (rejects in ms)
- wrong database name → `database "x" does not exist` (rejects in ms)
- server enforces TLS, client offered none → `no pg_hba.conf entry … SSL off` (rejects)
- `max_connections` reached → `sorry, too many clients already` (rejects)
- DNS failure → `ENOTFOUND` (rejects)

The surviving class is narrow: **something accepted the TCP connection and then
never spoke Postgres back**, or **the client process never got to read the reply**.
The candidate list below is ordered by that constraint, not by folklore.

The sentence "usually indicates an incorrect database URL or an SSL configuration
issue" is upstream's guess. It has already misdirected one cycle. Treat it as noise.

## Second finding: the belief that this is macOS/podman-only is now falsified

`deploy/dokploy/README.md:539-587` records the identical failure locally, where the
database was provably reachable (direct `pg` 8 ms, knex 11 ms, 80 concurrent
connections 55 ms), and where raising the timeout to 300000 changed the message to
`Knex: Timeout acquiring a connection. The pool is probably full` — i.e. the stall
is in **pool acquisition**, not reachability. The README asserts "None of this has
been observed on Docker under Linux." This log is that observation. The assertion
is retired; the README must stop claiming it.

## Third finding — flagged, not yet explained

`admin.` and `vendor.` are **nginx SPA containers** (`deploy/dokploy/Dockerfile.dashboard`,
`nginx-spa.conf`). They serve static bundles and do not touch Postgres. Their 502
**cannot** be caused by the API's migration failure. Either they are crash-looping
for an unrelated reason, or the fault is in the shared layer (Traefik routing,
the `dokploy` network, host resource exhaustion on 3 vCPU) — and if it is the
shared layer, that materially raises candidate C1 below. This is one of two
observations the human must supply before stage 3 can claim anything is verified.

---

## In scope, ordered

### F0 — Establish whether this is one outage or two *(no code; human observation)*

- **Statement:** determine from the Dokploy panel whether the admin and vendor
  containers are running-and-routed or crash-looping.
- **Why this rank:** costs one panel screen, and the answer changes the ranking
  of every candidate below. If three independent containers are all 502, the
  shared network/proxy path is the prime suspect and F1's instrument should be
  read with that in mind.
- **Affected files:** none.
- **Delivery:** human, before stage 2 finishes.
- **Done when:** recorded as "dashboards up, API only" or "all three down".

### F1 — Read the Postgres service log at 2026-09-16T06:10 *(no code; human observation)*

- **Statement:** open the Postgres service's own log in the Dokploy panel and look
  for any entry at the failure timestamp.
- **Why this rank:** it is free, requires no redeploy, and it single-handedly
  splits the candidate space in two. **Any** entry at 06:10 (connection received,
  authenticated, fatal, anything) proves the client's packets reached Postgres and
  eliminates C1/C3. **No entry at all** confirms C1 and makes the rest moot.
- **Affected files:** none.
- **Delivery:** human, before stage 2 finishes.
- **Done when:** the presence or absence of a 06:10 Postgres-side log line is recorded.

### F2 — One-shot runtime experiment: `MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=300000`

- **Statement:** raise the probe timeout in the Dokploy Environment tab and restart.
- **Why this rank:** it is the only experiment available today that needs **no
  rebuild and no code** — every value in `api.env.example` except `BUILD_JOBS` is
  runtime. Per the recorded local behaviour, a 300 s Medusa timer lets knex's own
  60 s `acquireConnectionTimeout` fire first and report the true cause. It converts
  a useless message into a real one for the price of a restart. It is a **probe,
  not a fix** — do not close the incident if it happens to let the migration through.
- **Affected files:** none in the repo (panel value only). Document afterwards in
  `deploy/dokploy/env/api.env.example`, `deploy/dokploy/README.md` — both LOCAL.
- **Delivery:** human, panel.
- **Done when:** the next log shows either a different, specific error, or the same
  generic timeout at 300 s (which itself eliminates pool starvation and promotes C1).

### F3 — Replace the TCP probe with a real authenticated preflight *(the instrument)*

- **Statement:** `wait_for()` in `deploy/dokploy/entrypoint-api.sh` proves only that
  a port is open. Add a second, mandatory phase that opens an authenticated
  connection with the bundled `pg` client, runs `SELECT 1`, and prints a bounded,
  redacted preflight report before `medusa db:migrate` ever runs.
- **Why this rank:** ranked below F0–F2 only because those cost nothing and need no
  deploy. It is the most important *deliverable* of this cycle. With no SSH on the
  host, the deploy log is the only instrument that exists, and today it lies: the
  line `postgres reachable` is printed by a raw `net.connect` and was the single
  biggest source of wasted diagnosis in this incident. `pg` and `knex` are already
  present in the runtime image (`apps/api/.medusa/server/node_modules/{pg,knex}`),
  so this costs no new dependency and no image-size change.
- **Affected files:** `deploy/dokploy/entrypoint-api.sh` (LOCAL — verified not
  present in `merge-base HEAD upstream/main`).
- **Delivery mechanism:** **direct edit**. No overlay — the file is ours.
- **Observable outcome:** a failing deploy log contains, in order: resolved host,
  port, database and user (password redacted), DNS result, TCP connect duration,
  authenticated `SELECT 1` duration or the driver's verbatim error, server version,
  and `SHOW max_connections` vs current backend count. A reader can name the failing
  layer from the log without shell access.

### F4 — Record the corrected failure model in the runbook

- **Statement:** rewrite "A note on the migration connection probe"
  (`deploy/dokploy/README.md:539+`): the message is a timer, not a diagnosis; the
  "Docker/Linux is unaffected" claim is withdrawn; the `psql`-in-container advice
  is useless on a host with no SSH and must be replaced by "read the F3 preflight
  block". Add the same warning next to `MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT` in
  `deploy/dokploy/env/api.env.example`.
- **Why this rank:** documentation that asserts a false negative cost this cycle a
  day. Leaving it in place guarantees the next responder repeats the mistake.
- **Affected files:** `deploy/dokploy/README.md`, `deploy/dokploy/env/api.env.example`
  (both LOCAL).
- **Delivery:** direct edit.
- **Done when:** neither file claims Linux immunity, and both point at the F3 report.

### F5 — Contingency only: overlay 015 for `databaseDriverOptions`

- **Statement:** if and only if F3's report shows a TLS stall or pool starvation,
  `apps/api/medusa-config.ts` needs `databaseDriverOptions` (`ssl`, `pool.min/max`,
  `connectionTimeoutMillis`). That file is **UPSTREAM-tracked** — verified.
- **Why this rank:** last, because it is conditional. Do not pre-emptively write it;
  an overlay written against an unconfirmed cause is a permanent merge-conflict tax
  for nothing. `medusa-config.ts` exposes no env passthrough for these options, so
  there is no runtime escape hatch — an overlay is the only route.
- **Affected files:** `apps/api/medusa-config.ts`.
- **Delivery mechanism:** **new patch `deploy/overlays/015-*.patch`**, applied on a
  copy at image build. Never edited in a commit. Rule 0.
- **Done when:** the migration completes and `/health` returns 200, or the item is
  formally dropped because F3 pointed elsewhere.

---

## Candidate root causes, ranked, each with its cheapest discriminator

Panel + logs only. No SSH. "After F3" means the observation only becomes available
once the diagnostic preflight ships.

### C1 — TCP accepted by something that is not Postgres *(highest)*

A Swarm ingress/routing-mesh VIP, a Traefik TCP entrypoint, or a stale service
alias accepts the connect and then blackholes the stream. The startup packet gets
no reply, so the client hangs forever — which is exactly and only what the timeout
branch can produce. Consistent with every eliminated fast-reject cause, and with
F0 if the dashboards are also 502.

- **Cheapest discriminator:** F1. Zero Postgres-side log entries at 06:10 confirms it.
- **Second:** after F3, the report shows TCP connect succeeding in ms while the
  authenticated probe never returns a server version.

### C2 — Pool-acquisition / event-loop starvation on 3 vCPU

`knex` never hands the probe a usable connection: either the pool is starved, or
Node's event loop is blocked long enough by Mercur's module graph loading under
`migrationOnly` that an overdue timer fires in the timers phase before the socket's
reply is read in the poll phase. A 3-vCPU host that may also be running a build
makes this credible. This is the documented local failure, now plausibly reproduced
on Linux.

- **Cheapest discriminator:** F2. At 300 s the message changes to
  `Knex: Timeout acquiring a connection. The pool is probably full` → confirmed.
  Same generic 300 s timeout → eliminated, promote C1.
- **Supporting:** the Dokploy panel's CPU graph at 06:10; if a build overlapped the
  deploy, starvation is the likelier reading.

### C3 — TLS handshake that never completes

Client sends `SSLRequest`; a proxy or managed-Postgres front end neither accepts
nor refuses. Hangs identically. Note the *reverse* case (server requires TLS, client
offers none) is already eliminated — that rejects fast.

- **Cheapest discriminator:** does `DATABASE_URL` carry `sslmode=`/`ssl=true`, and
  is the target Dokploy's own Postgres container (no TLS) or an external managed
  provider (TLS enforced)? One glance at the Environment tab and the Postgres
  service page. An internal Dokploy Postgres with no `sslmode` in the URL eliminates C3.
- **After F3:** the report names the effective sslmode and where the probe stopped.

### C4 — pgbouncer / connection proxy in front of Postgres

Transaction-pooling proxies queue rather than refuse when their own pool is
exhausted — turning a would-be fast reject into a hang. Also incompatible with some
migration-time session state.

- **Cheapest discriminator:** is there a pooler service in the Dokploy project at
  all, and does `DATABASE_URL`'s port differ from the Postgres service's own
  (6432 vs 5432)? If the URL points straight at the Postgres container's 5432,
  eliminated.

### C5 — Server-side connection saturation caused by the crash-loop itself

Each restart runs migrations again and opens pools; if connections are not reaped,
the loop becomes self-sustaining. Normally rejects fast (`too many clients`), so it
only fits this log combined with C4's queueing behaviour.

- **Cheapest discriminator:** Postgres service log for `too many clients` or a
  rising connection count across restarts (F1 shows this for free).
- **After F3:** the preflight prints current backends vs `max_connections`.

### C6 — Wrong database name, role, or password

Retained only for completeness. The message shape excludes it.

- **Cheapest discriminator:** F1 — an auth or missing-database FATAL in the Postgres
  log. Its total absence is the point.

### C7 — Host resource starvation on 3 vCPU

Not a standalone cause of a 30 s protocol stall, but a credible amplifier of C2 and
a candidate explanation for F0 if all three containers are down.

- **Cheapest discriminator:** the panel's host CPU/memory graph at 06:10, plus
  whether a build was running concurrently.

---

## Product decisions

### D1 — How much diagnostic output before `medusa db:migrate`?

**Decision: a fixed, always-on preflight report of roughly 15–20 lines. Not gated
behind a debug flag.**

Reasoning: the only reason to keep boot logs terse is noise. There is no SSH on this
host, the panel is the entire observability surface, and the log is written once per
container start — not per request. A debug flag is worthless here precisely because
the failure is at boot: by the time someone knows to set the flag, they have already
paid for a blind cycle. Twenty lines per boot is not a cost; a second undiagnosable
outage is.

Constraints on the report: **credentials are redacted** (Dokploy renders logs in the
browser and retains them — the existing entrypoint already dumps env *names only*
for this reason, and that discipline holds); output is **bounded** (no unbounded
server-side dumps); and each line states what it proves, not just what it did.

### D2 — Must preflight perform a real authenticated `SELECT 1` rather than a TCP probe?

**Decision: yes, mandatory and fatal, using the same `pg` driver and the same
`DATABASE_URL` Medusa will use.**

Reasoning: `wait_for()` proves a port is open and prints `postgres reachable`. That
line is false reassurance and it actively misdirected this incident's diagnosis —
it is indistinguishable between a healthy database, a Swarm VIP blackhole, a wrong
database name, and a bad password. A probe that can be true while every real
precondition is false is worse than no probe. The authenticated probe must share the
driver and URL with Medusa, or its success has no transfer value.

**Keep the TCP phase**, do not replace it: it is still the only cross-service startup
ordering guarantee Dokploy offers (`depends_on` cannot span Applications). Demote it
to phase 1 and relabel its output to say what it actually proves — "tcp port open
(not authenticated)". Phase 2 is the authenticated probe with its own retry window
and its own timeout, and it fails the container with a message naming the layer.

### D3 — Where does the timeout knob sit?

**Decision: `MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT` stays at 30000 in the shipped
example; 300000 is documented as a *diagnostic* step, never as a remedy.**

Reasoning: raising it does not fix a stalled connection, it only changes which timer
reports the stall — which is useful exactly once, as an experiment (F2). Shipping
300000 as the default would trade a 30-second crash-loop for a five-minute one and
delete the only signal the current log carries.

### D4 — Does the entrypoint retry the migration?

**Decision: no unbounded retry. The authenticated preflight retries within a bounded
window (same budget as `WAIT_TIMEOUT`), then exits with a specific message.**

Reasoning: under C5 a retrying migrator makes the problem worse by holding more
connections, and Dokploy's restart policy already supplies the outer loop. The value
is in the message, not the persistence.

---

## Out of scope

- **TypeScript errors in `apps/api/src/scripts/**`.** Pre-existing, tolerated by
  design (`medusa build || true` plus an artifact assertion), and provably not the
  outage — the build succeeded and the container reached the migration step. Worth
  an upstream report, not a cycle slot. Fixing them would require overlays over
  six upstream files for zero effect on availability.
- **Any refactor of `medusa-config.ts` beyond a conditional, minimal overlay (F5).**
  Upstream file; every line touched is a permanent merge tax.
- **Changing the Postgres topology** (adding a pooler, moving to a managed provider,
  switching to bundled compose). Premature until F1/F3 name the failing layer.
- **Resizing the host or reworking build parallelism.** C7 is an amplifier, not the
  cause; `BUILD_JOBS=2` is already correct for 3 vCPU.
- **Traefik / domain / certificate configuration**, unless F0 shows the dashboards
  are also down — in which case it becomes a *separate* incident with its own cycle,
  not an addendum to this one.
- **Anything in `packages/core/**`.** Nothing in the evidence points there.

---

## Blocked on the human

No **product decision** is blocked — D1–D4 are decided and stage 2 may begin on F3
and F4 immediately, since the instrument is required under every candidate.

Two **observations** are required before stage 3 can verify anything, and only the
human can take them (panel access, no SSH):

1. **F0** — are the admin and vendor containers running, or crash-looping? This
   determines whether this is one incident or two.
2. **F1** — does the Postgres service log show *any* entry at 2026-09-16T06:10?
   Presence eliminates C1/C3; absence confirms C1 and collapses the rest.

Optional but near-free, and it would likely shorten the cycle:

3. **F2** — set `MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=300000` in the panel and
   restart. No rebuild. Report the new message verbatim.
4. Confirm whether the Postgres target is Dokploy's own container or an external
   managed provider, and whether `DATABASE_URL` carries any `sslmode` parameter
   (answer without pasting the password).

---

## Upstream-report items

No security findings in this incident. Nothing here warrants a private disclosure
or an embargo; all three items are diagnosability defects and can be filed publicly.

1. **medusajs/medusa — `verifyMigrationConnection` asserts a cause it has not
   established.** The timeout branch tells the operator the URL or SSL config is
   wrong. In both observed cases the URL was correct and the stall was in pool
   acquisition. The function already knows the difference — a timer expiry and a
   driver rejection take different branches — but flattens both into URL/SSL blame.
   Ask for: the timeout message to state only what is known ("no response within Ns"),
   and for the pending-query/pool state to be reported when the timer wins the race.
   This message cost this incident a full diagnostic cycle.

2. **mercurjs/mercur — `apps/api/medusa-config.ts` offers no env passthrough for
   `databaseDriverOptions`.** `ssl` and `pool` are reachable only by editing the
   config, so every deployer on a TLS-enforcing or pooled Postgres must fork the
   file. An env-driven default would remove the need for overlay 015 entirely.

3. **mercurjs/mercur — `apps/api/src/scripts/**` does not type-check.** Nine errors
   across six seed/dev scripts. Harmless at runtime, but it forces every production
   Dockerfile to run `medusa build || true`, which discards the build's ability to
   fail on a real error. Low priority, real cost.

---

## Rule 0 compliance for this cycle

Ownership verified against `merge-base HEAD upstream/main` = `a925daf621d8a8e2b16c072404896e38172216bb`:

| Path | Owner | Mechanism |
|---|---|---|
| `deploy/dokploy/entrypoint-api.sh` | LOCAL | direct edit (F3) |
| `deploy/dokploy/README.md` | LOCAL | direct edit (F4) |
| `deploy/dokploy/env/api.env.example` | LOCAL | direct edit (F4) |
| `docker-compose.dokploy*.yml` | LOCAL | direct edit if needed |
| `docs/FIX-PLAN-api-502-migrations.md` | new file | direct (this document) |
| `apps/api/medusa-config.ts` | **UPSTREAM** | `deploy/overlays/015-*.patch` only (F5) |

Before any commit: `git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"`
must be empty. Use `/Library/Developer/CommandLineTools/usr/bin/git` — `/usr/bin/git`
is broken by the Xcode licence prompt. If overlays are applied in the checkout, run
`./deploy/overlays/apply.sh --revert` first.
