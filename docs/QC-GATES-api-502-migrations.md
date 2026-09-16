# QC GATES — api.nokor24.com 502 / migration connection timeout

Stage 2 (QC), pass 1. Input: `docs/FIX-PLAN-api-502-migrations.md` (PO work order).
Downstream: mercur-tester → mercur-dev → QC pass 2.

Scope gated here: **F3** (the preflight instrument in `deploy/dokploy/entrypoint-api.sh`)
and **F4** (runbook correction). F0/F1/F2 are human observations — not gateable code.
F5 is conditional and is gated only by the overlay rules in §7.

Ownership re-verified against `merge-base HEAD upstream/main` =
`a925daf621d8a8e2b16c072404896e38172216bb`:

| Path | Owner | Mechanism |
|---|---|---|
| `deploy/dokploy/entrypoint-api.sh` | LOCAL | direct edit |
| `deploy/dokploy/Dockerfile.api` | LOCAL | direct edit (see G1) |
| `deploy/dokploy/README.md` | LOCAL | direct edit |
| `deploy/dokploy/env/api.env.example` | LOCAL | direct edit |
| `apps/api/medusa-config.ts` | **UPSTREAM** | `deploy/overlays/015-*.patch` only |

`git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"` was
empty at gate-writing time and must be empty at review time.

---

## 0. Critical review of the PO plan — read before implementing

Four of the PO's technical premises are wrong, unverified, or insufficient. These are
raised now, not at review time.

### 0.1 The `pg` location claim is stated for the wrong stage — VERIFIED, with a caveat

PO F3 says `pg` and `knex` are present at `apps/api/.medusa/server/node_modules/{pg,knex}`.
That is the **build** stage path. In the runtime image `Dockerfile.api:127-129` does
`WORKDIR /app` + `COPY --from=build /repo/apps/api/.medusa/server ./` + a **fresh**
`bun install --production --ignore-scripts`. So the runtime path is
`/app/node_modules/pg`, produced by a *different* install resolution than the one the
PO inspected.

What I verified myself in this checkout:

```
apps/api/.medusa/server/node_modules/pg    -> pg 8.23.0
apps/api/.medusa/server/node_modules/knex  -> knex 3.2.10
```

Both are **transitive** (neither appears in `.medusa/server/package.json` dependencies;
they arrive under `@medusajs/framework` → `@mikro-orm/postgresql` → `knex` → `pg`).
The PO's own scratch dir records `pgpath = node_modules/.bun/pg@8.21.0+.../node_modules/pg`
— i.e. in at least one tree `pg` was reachable only through bun's isolated store, and a
top-level `node_modules/pg` entry is a hoisting artefact, not a guarantee. A
`--production` install can hoist differently.

**Consequence for the gates:** "pg is present" is an assumption the implementation must
*prove in the built image* (G1) and *assert at build time* (G2), not inherit from the
work order. A missing `pg` under a mandatory-fatal preflight would take down every
deploy, including healthy ones.

### 0.2 An authenticated `SELECT 1` alone does NOT separate C1 from C3

Both C1 (TCP accepted, nothing speaks Postgres) and C3 (TLS handshake never completes)
present to `pg.Client.connect()` as the same thing: a promise that never settles until
`connectionTimeoutMillis`. Shipping only phases "TCP" + "authenticated SELECT 1" leaves
the top-ranked candidate and the third-ranked candidate indistinguishable — which is the
exact defect this cycle exists to remove.

**Therefore G5 is mandatory:** a raw wire-protocol phase between the TCP phase and the
authenticated phase. Open a socket, write the 8-byte `SSLRequest` packet
(`00 00 00 08 04 D2 16 2F`), and read **one** byte.
- byte `S` or `N` within the window → something on that port speaks the Postgres wire
  protocol → C1 eliminated, and the byte names the server's TLS posture.
- no byte, socket stays open → **C1 confirmed**, and this is the single most valuable
  line the instrument can print.
- connection closed/reset without a byte → not Postgres either, distinct sub-case.

This needs `net` and `Buffer` only. No dependency, ~12 lines.

### 0.3 The instrument cannot reproduce C2, and silence about that will be misread

The preflight uses a single `pg.Client`. Knex's pool is not involved, so a passing
preflight does **not** exonerate C2 — C2's signature is precisely "preflight healthy,
then Medusa times out anyway". If the report does not say this in words, the next
responder will read `PREFLIGHT OK` as "the database is fine" and lose another cycle to
exactly the misdirection that `postgres reachable` caused this cycle. G7 makes the
handoff sentence mandatory.

### 0.4 D4's retry budget doubles worst-case boot time — must be stated, not discovered

"same budget as `WAIT_TIMEOUT`" for phase 4, on top of the existing `WAIT_TIMEOUT` for
phase 2, means worst-case preflight is `2 × WAIT_TIMEOUT` (default 240 s) before the
container exits. Dokploy's healthcheck `--start-period` is 120 s
(`Dockerfile.api:153`). This is acceptable (the healthcheck only governs routing, not
restarts) but it must be explicit in the log and in the runbook, or the next responder
will read a 4-minute silent boot as a hang. See G10 and G13.

### 0.5 Smaller points

- `wait_for()` currently passes `DATABASE_URL` as **argv** to `node -e`
  (`entrypoint-api.sh:88`), putting the password in `/proc/<pid>/cmdline` and in `ps`.
  The new phases must **not** repeat this (G8). Fixing the existing call is *recommended*
  and in scope as a one-line change; it is not a blocking gate.
- The env example's `MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=30000` is a value Medusa
  otherwise defaults to 10000. Keep 30000. The entrypoint must never set or export this
  variable itself (G9).
- F5's `databaseDriverOptions` route is sound for Medusa 2.x (`projectConfig.databaseDriverOptions`
  accepts `ssl`, `pool`, `connection`). No objection — but it stays unwritten until F3
  produces evidence, per §7.

---

## 1. The report contract (F3) — what must be printed

The instrument is judged on **greppable, mutually exclusive verdict tokens**, not prose.
Surrounding wording is free; the tokens are the contract. Every run emits exactly one
line matching `^ *PREFLIGHT (OK|FAIL:)`.

### 1.1 Phase labels (mandatory, in this order, one line each on entry)

```
[preflight 1/4] environment
[preflight 2/4] tcp reachability      (proves: a port is open. NOT that it is Postgres.)
[preflight 3/4] postgres wire protocol
[preflight 4/4] authenticated session
```

Phase 2 is the existing `wait_for()` — **relabelled**, not replaced (D2). Its current
success line `  postgres reachable` is **forbidden** to remain unqualified: it must read
as "tcp port open (not authenticated)" or equivalent. That exact string was the single
biggest source of wasted diagnosis in this incident.

### 1.2 Verdict tokens — one per failure mode, mutually exclusive

| # | Failure mode | Required verdict token | Required supporting evidence on the same or adjacent line |
|---|---|---|---|
| V0 | Healthy | `PREFLIGHT OK` | `connect_ms=`, `select1_ms=`, `server_version=`, `backends=<n>/<max_connections>` |
| V1 | `pg` driver not resolvable in the image | `PREFLIGHT FAIL: pg-driver-unavailable` | the resolution paths that were tried |
| V2 | DNS failure | `PREFLIGHT FAIL: dns` | `host=<host>` and `code=ENOTFOUND`/`EAI_AGAIN` |
| V3 | TCP refused / unreachable / timed out | `PREFLIGHT FAIL: tcp-unreachable` | `host=<host> port=<port>` + elapsed seconds |
| V4 | **TCP open, nothing speaks Postgres** (C1) | `PREFLIGHT FAIL: no-postgres-protocol-response` | `tcp_connect_ms=<small>` and `no reply to SSLRequest within <n>s` |
| V5 | Port open, closes without a protocol byte | `PREFLIGHT FAIL: protocol-reset` | `code=ECONNRESET` or `closed after <n>ms` |
| V6 | TLS negotiation stalls, or sslmode mismatch | `PREFLIGHT FAIL: tls` | the effective `sslmode=<v>`, the SSLRequest reply byte (`S`/`N`), and where it stopped |
| V7 | Auth failure | `PREFLIGHT FAIL: auth` | `code=28P01` or `code=28000` |
| V8 | Database does not exist | `PREFLIGHT FAIL: database-missing` | `code=3D000` |
| V9 | Server-side connection limit | `PREFLIGHT FAIL: server-connection-limit` | `code=53300` |
| V10 | Protocol byte received, but connect/`SELECT 1` never completes (pooler queueing, C4; or a stalled backend) | `PREFLIGHT FAIL: auth-stall` | `protocol_reply=S\|N` received at `<n>ms`, then `no session within <n>s` |
| V11 | Any other driver error | `PREFLIGHT FAIL: driver` | `code=<pg code> name=<err.name>` and the verbatim `err.message` |

Rules on the table:
- **Mutually exclusive.** No input may produce two `PREFLIGHT FAIL:` lines or none.
- V4 vs V6 vs V10 is the discriminator triplet this whole cycle is being run for. If an
  implementation collapses any two of them into one token, it fails review (§6 R3).
- The exit path for every `FAIL` is `exit 1` after the line is flushed.

### 1.3 Always-printed facts (redacted), ~15-20 lines total

Printed on **every** boot, healthy or not, before phase 4's verdict:

```
  host=<hostname>            (from DATABASE_URL)
  port=<port>
  database=<dbname>
  user=<username>
  password=<set|EMPTY>       (never the value, never its length)
  sslmode=<value|none>       (from the URL query, verbatim)
  dns=<resolved ip(s)> in <n>ms
  tcp_connect_ms=<n>
  protocol_reply=<S|N|none>
  connect_ms=<n>             (phase 4, to an authenticated session)
  select1_ms=<n>
  server_version=<n>
  backends=<n>/<max_connections>
```

Hard cap: **25 lines** for phases 3+4 combined on any path. No `pg_stat_activity` row
listing, no table dumps, no `err.stack`, no `console.error(err)` of a whole object.

### 1.4 The handoff sentence (mandatory on the OK path)

After `PREFLIGHT OK`, one line to the effect of:

> database reachable and authenticated at this instant — if `medusa db:migrate` still
> reports a connection timeout after this line, the stall is client-side (knex pool
> acquisition / blocked event loop), not reachability.

Without it, `PREFLIGHT OK` becomes the new `postgres reachable` (see §0.3).

---

## 2. Correctness rules

| ID | Rule | How it is checked |
|---|---|---|
| G1 | `pg` resolves in the **built runtime image** at `/app`. | `podman run --rm --entrypoint node <img> -e "console.log(require.resolve('pg'))"` prints a path. |
| G2 | `Dockerfile.api` gains a build-time assertion in the `runtime` stage, after `bun install --production`, that `pg` resolves. A missing driver must fail the **build**, not every container start. | the `RUN` line exists; deliberately breaking it fails the build. |
| G3 | **No new runtime dependency.** No `package.json` change anywhere, no `bun add`, no `apt-get install`, no network fetch at start. | `git diff` touches no `package.json`/`bun.lock`; `Dockerfile.api` gains no new `apt-get` package. |
| G4 | Only **one additional `node` process** for phases 3+4 combined. Node cold start on the 3-vCPU host is the dominant cost; three probes = three cold starts. | `grep -c 'node ' entrypoint-api.sh` accounted for line by line in review. |
| G5 | The wire-protocol phase (§0.2) exists and uses `net` only. | scenario B in §4 produces V4. |
| G6 | **Healthy-boot budget: the new phases add ≤ 2.0 s wall clock**, measured as (total preflight time after the change) − (before), against a local Postgres. Hard ceiling 3.0 s; above that, reject. | scenario A timing in §4. |
| G7 | The handoff sentence of §1.4 is present on the OK path. | `grep` in scenario A. |
| G8 | **No credential ever reaches a log line, an argv, or an env dump.** Specifically: the new node process reads `process.env.DATABASE_URL` itself and receives **no** URL or password on argv; the full URL is never printed; every emitted line is passed through a scrubber that replaces the decoded password *and* its raw percent-encoded form with `***` when non-empty; errors print only `name`, `code`, `severity`, `message`. | scenario F in §4 (password `p@ss/w0rd-SECRET`); `grep -F SECRET` over the whole log must find nothing. |
| G9 | The entrypoint neither sets, exports, nor defaults `MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT`. | `grep MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT deploy/dokploy/entrypoint-api.sh` → no match. |
| G10 | **Bounded retry only.** Phase 4 retries within a deadline ≤ `WAIT_TIMEOUT` seconds and then exits non-zero. No `while true`, no unbounded loop, no retry of `medusa db:migrate` itself. The node process enforces its own deadline internally (a hung socket must not outlive it). | code read + scenario B completes and exits within the stated window. |
| G11 | **Exit semantics never soften.** Every failure path ends in a non-zero `exit` after printing. No path may `exit 0` on failure, swallow a failure with `|| true`, background a probe, or leave the script blocked with nothing printed. A crash-loop must stay a crash-loop with a better message. | scenarios B/C/D/E: `echo $?` is non-zero every time. |
| G12 | **POSIX `sh` only.** Shebang stays `#!/bin/sh`. No `local`, no arrays, no `[[ ]]`, no `function` keyword, no `echo -e`, no `${var,,}`, no `$'…'`, no `source`, no process substitution, no `pipefail`. `set -e` stays on, and the new code must be `set -e`-safe (no bare command substitution that can abort the script before its diagnostic prints). If the inlined JS contains a `'`, it must use a heredoc rather than a single-quoted sh string. | `sh -n`, `dash -n`, and `shellcheck -s sh` in §4 scenario G. |
| G13 | Worst-case preflight duration is stated in the log (e.g. `giving up after <n>s`) and in `README.md`. | grep. |
| G14 | **No `any`-equivalent sloppiness in the inline JS**: no empty `catch {}` that discards a diagnosis, no `process.exit(0)` in an error path. | code read. |

---

## 3. Regression rules — what must not change

| ID | Invariant | Check |
|---|---|---|
| R1 | Cross-Application startup ordering survives. The TCP wait for **postgres and redis** still runs, still retries every 2 s, still honours `WAIT_TIMEOUT` (default 120). D2: demote and relabel, do not delete. | scenario A log shows both waits; scenario H (`WAIT_TIMEOUT=6` against a dead port) fails in ~6-9 s, not 120. |
| R2 | `WAIT_TIMEOUT` keeps its current meaning for phase 2 exactly. Phase 4's budget is separate and additionally documented. | scenario H. |
| R3 | The missing-env preflight block (`entrypoint-api.sh:18-54`) is unchanged in behaviour: reports **all** missing vars at once, dumps env **names only**, exits 1. | scenario I: run with `DATABASE_URL` unset → same output as before the change, byte-comparable apart from deliberate additions. |
| R4 | Redis wait, `RUN_SEED` block, `ADMIN_EMAIL` block, and the final `exec node "$MEDUSA" start` are untouched. | `git diff` shows no hunks in those regions. |
| R5 | On a fully healthy boot, behaviour is identical apart from added log lines: migrations run, seed/admin blocks behave the same, the server starts and `/health` returns 200. | scenario A end-to-end. |
| R6 | No change to `docker-compose.dokploy*.yml`, `HEALTHCHECK`, `EXPOSE`, `PORT` handling, or the `ENTRYPOINT` declaration. | `git diff`. |
| R7 | No upstream-tracked file modified. | `git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"` is **empty**. |
| R8 | No overlay added for F3/F4 (the files are LOCAL — an overlay would be wrong here). If F5 later ships, §7 applies. | `ls deploy/overlays` unchanged unless §7 is invoked. |

Plausible breakage to watch for specifically:
- `set -e` + a probe that returns non-zero inside a command substitution → script dies
  **before** printing its own diagnosis. This is the most likely self-inflicted wound;
  it converts a good instrument into a worse crash than today's.
- A `node` inline script with an unhandled promise rejection exits 1 with a stack trace
  that may contain the connection string. Covered by G8, but check it explicitly.
- Phase 4 made fatal without G10's deadline → a container that hangs forever instead of
  crash-looping. That is strictly worse than today and is an automatic reject (G11).

---

## 4. Verification plan — commands and expected output

All scenarios run from the repo root with `podman`. Scratch dir `/tmp/repro502` already
holds `blackhole.js` from stage 1; reuse it.

Build once (the image is the only place `pg` resolution is real):

```sh
podman build -f deploy/dokploy/Dockerfile.api -t mercur-api:qc .
podman run --rm --entrypoint node mercur-api:qc -e "console.log(require.resolve('pg'))"
# EXPECT: a path under /app/node_modules  → G1
```

For fast iteration, mount the edited script over the image copy instead of rebuilding:

```sh
RUN="podman run --rm --network host \
  -v $PWD/deploy/dokploy/entrypoint-api.sh:/usr/local/bin/entrypoint-api.sh:ro \
  -e REDIS_URL=redis://127.0.0.1:6379 --entrypoint sh mercur-api:qc \
  /usr/local/bin/entrypoint-api.sh"
```

Each scenario: capture the full log, then assert on tokens and exit code.

| # | Scenario | Setup | EXPECT (grep) | EXPECT exit |
|---|---|---|---|---|
| A | Healthy | real Postgres 16 + Redis up, correct URL | `PREFLIGHT OK`, `select1_ms=`, `backends=`, handoff sentence (G7); `time` delta vs the pre-change script ≤ 2.0 s (G6) | 0 through preflight; proceeds to `→ Running migrations` |
| B | TCP open, not Postgres (**C1**) | `node /tmp/repro502/blackhole.js` on 55433; `DATABASE_URL=postgres://u:p@127.0.0.1:55433/mercur` | `PREFLIGHT FAIL: no-postgres-protocol-response`; and the phase-2 line still says the port is open-but-unauthenticated | non-zero, within the stated window |
| C | Auth failure | real Postgres, wrong password | `PREFLIGHT FAIL: auth`, `code=28P01` | non-zero |
| D | Missing database | real Postgres, `/nosuchdb` | `PREFLIGHT FAIL: database-missing`, `code=3D000` | non-zero |
| E | sslmode mismatch | real non-TLS Postgres, URL with `?sslmode=require` | `PREFLIGHT FAIL: tls`, `sslmode=require`, `protocol_reply=N` | non-zero |
| E2 | TLS stall | listener that answers `S` to SSLRequest then never completes the handshake | `PREFLIGHT FAIL: tls` **or** `PREFLIGHT FAIL: auth-stall`, and `protocol_reply=S` — must **not** print V4 | non-zero |
| F | Redaction | healthy Postgres, role password `p@ss/w0rd-SECRET` (URL-encoded) | `grep -F SECRET` over the full log → **no match**; `grep -F 'p%40ss'` → no match (G8) | 0 |
| G | Shell conformance | — | `sh -n deploy/dokploy/entrypoint-api.sh`; `podman run --rm -v $PWD:/w:ro debian:bookworm-slim dash -n /w/deploy/dokploy/entrypoint-api.sh`; `podman run --rm -v $PWD:/w:ro koalaman/shellcheck:stable -s sh /w/deploy/dokploy/entrypoint-api.sh` | all clean (G12); shellcheck warnings must be zero or individually justified in review |
| H | `WAIT_TIMEOUT` still works | `WAIT_TIMEOUT=6`, `DATABASE_URL` → closed port 55999 | `PREFLIGHT FAIL: tcp-unreachable`; wall clock 6-10 s, not 120 (R1/R2) | non-zero |
| I | Missing env unchanged | unset `DATABASE_URL` | `MISSING: DATABASE_URL` + env **names** dump, no values (R3) | 1 |
| J | Pool-stall readability (**C2**) | healthy Postgres, then `MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=1` to force the Medusa timer | log shows `PREFLIGHT OK` + handoff sentence *followed by* the Medusa timeout — a reader can conclude "client-side, not reachability" from the log alone (§0.3) | non-zero at migrate |
| K | Rule 0 | — | `/Library/Developer/CommandLineTools/usr/bin/git diff --diff-filter=MDR --name-only "$(… merge-base HEAD upstream/main)"` → empty (R7) | — |

The tester owns A-K as a reproducible script. **Scenario B must fail against the current
`entrypoint-api.sh` and pass against the fixed one** — it is the repro for this cycle;
today's script prints `postgres reachable` and proceeds, which is exactly the lie being
removed.

### F4 (runbook) checks

| # | Check |
|---|---|
| L | `grep -n "not been observed on Docker under Linux\|not reproduced on Docker under Linux" deploy/dokploy/README.md` → **no match** (the claim is falsified; PO §"Second finding"). |
| M | `deploy/dokploy/README.md:539+` states the message is a **timer expiry**, not a diagnosis, and points the reader at the F3 preflight block by its token names. |
| N | The `psql`/`node -e` in-container advice is removed or explicitly marked useless on a host with no SSH. |
| O | `deploy/dokploy/env/api.env.example` keeps `MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=30000` **active**, with `300000` mentioned only as a commented diagnostic and labelled "never a shipped default" (D3). `grep -n "^MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=300000"` → no match. |
| P | The worst-case preflight duration (G13) and the meaning of each verdict token are documented in the README, so the token table is not only in this file. |

---

## 5. What "done" means for F3

All of: G1-G14 pass, R1-R8 hold, scenarios A-K produce the expected tokens and exit
codes, L-P hold for F4, and `bun run lint` + `bun run build` are unchanged (this touches
no TypeScript, so both must be exactly as green as on the current `main` — a change in
either is evidence of scope creep).

---

## 6. Rejection criteria — any one of these sends it back

- **R1** `pg` is required at runtime without the build-time assertion (G2), or the
  implementation assumes the PO's build-stage path without proving the runtime one.
- **R2** Any new dependency, `package.json`/`bun.lock` change, or `apt-get` line.
- **R3** V4 / V6 / V10 collapsed into fewer tokens, or any two failure modes producing
  the same verdict token. This is the core deliverable; approximations are not accepted.
- **R4** Any credential, full `DATABASE_URL`, password length, or password in argv
  appears anywhere — including inside a driver error message or a stack trace.
- **R5** A failure path that exits 0, hangs without a deadline, or is silenced with
  `|| true`. Turning a crash-loop into a silent hang is the worst possible outcome here.
- **R6** Unbounded retry, or retrying `medusa db:migrate`.
- **R7** Bash-isms, a changed shebang, or `shellcheck -s sh` / `dash -n` failures.
- **R8** The existing `postgres reachable` line surviving unqualified, or the TCP wait
  being deleted rather than demoted (breaks the only startup ordering Dokploy offers).
- **R9** Healthy boot slower than 3.0 s extra, or more than one extra `node` process.
- **R10** Any modification to an upstream-tracked file, or an overlay used for a LOCAL
  file.
- **R11** Unrelated changes smuggled in: seed logic, admin-user logic, `HEALTHCHECK`,
  compose files, `BUILD_JOBS`, the `apps/api/src/scripts` TypeScript errors (explicitly
  out of scope), or a speculative F5 overlay written before F3 produces evidence.
- **R12** `MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=300000` shipped as an active default
  in `api.env.example` or set by the entrypoint.
- **R13** The handoff sentence (§1.4) missing, so `PREFLIGHT OK` can be misread as
  "the database is fine".

---

## 7. Gates for F5 (conditional — only if F3's evidence demands it)

Do not pre-write this. If and only if the shipped preflight reports V6 (`tls`) or the
C2 signature (V0 followed by a Medusa timeout):

- One overlay, `deploy/overlays/015-<one-concern>.patch`, touching
  `apps/api/medusa-config.ts` only, adding `databaseDriverOptions` only.
- One concern per overlay — `ssl` and `pool` tuning may share the patch only if the
  evidence names both; otherwise split.
- `./deploy/overlays/apply.sh --check` reports it `pending` on a pristine tree and
  `applied` after `apply.sh`.
- `apply.sh --revert` restores the tree, and
  `git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"` is
  empty afterwards.
- `podman build -f deploy/dokploy/Dockerfile.api` still succeeds with the overlay in the
  image (the build applies overlays at `Dockerfile.api:113`).
- The patch is never committed in an applied state.

---

## 8. Handoff

- **Tester:** own scenarios A-K as a runnable script under `/tmp/repro502`. Scenario B is
  the repro that must fail before and pass after.
- **Dev:** §1 is the output contract, §2 the correctness rules, §3 the regression surface.
  Read §0 first — two of the PO's premises need work you would otherwise skip.
- **QC pass 2:** re-run every scenario independently; do not accept a self-report.

---

# QC pass 2 — final review

Reviewed commit `de0db2811` *fix(deploy): make the api preflight name its own failure
instead of guessing* (4 files: `deploy/dokploy/{entrypoint-api.sh,Dockerfile.api,README.md,env/api.env.example}`).
Everything below was re-run by QC against the committed script mounted over
`localhost/mercur-api:qc`; the dev's self-report was not taken on trust. Logs in
`/tmp/repro502/qc2/`.

**VERDICT: REJECT** — two required code changes, both small. Details in §V3 and §V1.
Everything else passes, including the core V4/V6/V10 discriminator.

## Gate results

| Gate | Result | Evidence |
|---|---|---|
| G1 `pg` resolves in the built image | **PASS** | `podman run --entrypoint node mercur-api:qc -e "require.resolve('pg')"` → `/app/node_modules/pg/lib/index.js` 8.23.0 |
| G2 build-time assertion | **PASS** | `Dockerfile.api:138` `RUN node -e "...require('pg/package.json')..."` after the `--production` install |
| G3 no new dependency | **PASS** | commit touches 4 files; no `package.json`/`bun.lock`/`apt-get` |
| G4 one extra node process | **PASS** | phases 3+4 share one `node "$PREFLIGHT_JS"` (`entrypoint-api.sh:525`); the two `wait_for` nodes are pre-existing |
| G5 raw SSLRequest phase | **PASS (byte-verified)** | listener on 55435 logged `RECEIVED_HEX=0000000804d2162f len=8`. `S`→ TLS offered (E2), `N`→ refused (E), no byte → V4 (B) |
| G6 healthy-boot budget ≤ 2.0 s | **PASS** | 3 runs each, container start → `→ Running migrations`: new 0.19/0.18/0.19 s, pre-change script 0.15/0.14/0.15 s → **+0.04 s**. Caveat: measured on Apple Silicon, not the 3-vCPU host; structurally it is one extra node cold start, so the host figure should be ~0.2-0.4 s, still far inside budget |
| G7 handoff sentence | **PASS** | scenario A, `entrypoint-api.sh:506-509`; printed immediately after `PREFLIGHT OK`, names knex's pool explicitly |
| G8 no credential in log/argv | **PASS** | `wait_for` now passes the URL via `WAIT_URL=` env and only the numeric timeout on argv (`:92`); the preflight reads `process.env.DATABASE_URL` itself. Scenario F (`p@ss/w0rd-SECRET`): `grep -F SECRET`, `-F p%40ss`, `-F w0rd` all 0 across the healthy, driver-error and unparseable-URL paths |
| G9 never sets `MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT` | **PASS** | `grep -c` → 0 |
| G10 bounded retry | **PASS** | budget `max(5, WAIT_TIMEOUT)*1000`; every retry gated on `remaining()`. B exited at 22 s of a 25 s budget; E2 at 10 s of 20 s. No `while true` on migrate |
| G11 exit semantics | **PASS** | B/C/D/E/E2/H/I all exit non-zero; no `|| true` on the preflight; the `if node …; else … exit 1` form is `set -e`-safe and still fatal |
| G12 POSIX sh | **PASS** | `sh -n` clean, `dash -n` (debian:bookworm-slim) clean, `shellcheck -s sh` **clean, zero warnings** |
| G13 worst case stated | **PASS** | in the report (`budget=…; worst case boot is 2 x WAIT_TIMEOUT = 240s`) and in `README.md:668-675` |
| G14 no discarded diagnosis | **PASS** | the three `catch {}` sites are `client.end()` after a diagnosis already captured, or percent-decoding fallbacks that `say()` a note. No `process.exit(0)` on an error path |

| Regression | Result | Evidence |
|---|---|---|
| R1/R2 `WAIT_TIMEOUT` semantics | **PASS** | scenario H (`WAIT_TIMEOUT=6`, closed port 55999): `PREFLIGHT FAIL: tcp-unreachable`, `code=ECONNREFUSED after 6s (budget 6s)`, wall 6 s |
| R3 missing-env block unchanged | **PASS** | scenario I: identical banner, env **names** only, exit 1. Only diff in that region is the comment header (`git show` shows one `-` line, a comment) |
| R4 redis/seed/admin/`exec start` untouched | **PASS** | the commit's only deletions are the 9 `wait_for`/label lines |
| R5 healthy boot identical + end-to-end | **PASS** | scenario A ran to `Migrations completed` and `Server is ready on port: 9000` |
| R6 compose/HEALTHCHECK/EXPOSE/PORT | **PASS** | not in the commit |
| R7/R10 no upstream file touched | **PASS** | `git diff --diff-filter=MDR --name-only a925daf62…` empty; all 4 files absent from the merge-base tree (LOCAL) |
| R8 no overlay for LOCAL files | **PASS** | `deploy/overlays` untouched |
| R11 no scope creep | **PASS** | no seed/admin/BUILD_JOBS/compose/F5 changes |

| Scenario | Expected | Observed | |
|---|---|---|---|
| A healthy | `PREFLIGHT OK` + facts + handoff | as specified, then migrations + server ready | PASS |
| B blackhole (C1) | `no-postgres-protocol-response` | token emitted, `tcp_connect_ms=1`, `protocol_reply=none`, `socket still open` | PASS (token string corrupted — see V3) |
| C wrong password | `auth` + `28P01` | `code=28P01 name=error severity=FATAL` | PASS |
| D missing db | `database-missing` + `3D000` | `code=3D000` | PASS |
| E sslmode mismatch | `tls`, `sslmode=require`, `protocol_reply=N` | all three | PASS |
| E2 answers `S` then stalls | `auth-stall`/`tls`, **not** V4 | `auth-stall`, `protocol_reply=S received at 2ms, then no session within 10s` | PASS |
| F redaction | no `SECRET`, no `p%40ss` | 0 matches on all paths | PASS |
| G shell conformance | clean | `sh -n`/`dash -n`/`shellcheck` clean | PASS |
| H `WAIT_TIMEOUT=6` | 6-10 s, `tcp-unreachable` | 6 s | PASS |
| I missing env | banner unchanged, exit 1 | unchanged | PASS (no token — see V2) |
| K invariant | empty | empty | PASS |
| L-P runbook | see below | see below | PASS with two corrections |

F4: **L** PASS (falsified Linux claim gone). **M** PASS (`README.md:585-606` names the timer
expiry and points at the token table). **N** PASS (`README.md:610-611` explicitly marks the
`psql`/`node -e` advice useless without SSH). **O** PASS (`MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=30000`
active; 300000 documented as a one-shot diagnostic, "never a shipped default"; no
`^MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=300000`). **P** PASS (full token table at
`README.md:625-640`) — with two factual corrections required, listed in V1 and V2.

§5's `bun run lint`/`bun run build` clause: **not re-run**, and I am saying so rather than
claiming it. The change set contains no TypeScript, JSON or package manifest — it is four
deploy files — so neither task's input changed. That is verifiable from the commit's file
list; it is not a measurement.

## Rulings on the three flagged deviations

### V1. `28000` split between `tls` and `auth` — **REJECTED as implemented** (the idea is right, the discriminator is not)

Dev's premise is correct: `28000` is what a TLS-requiring server returns, and calling that
`auth` sends the reader after credentials that are fine. The split should exist.

The message-shape heuristic does not implement it. `entrypoint-api.sh:354` tests
`/\bssl\b|\btls\b|certificate|self-signed|no encryption/i` against the driver message.
PostgreSQL appends the connection's encryption state to **every** `pg_hba.conf`-class
`28000`, whatever the cause — `, no encryption` / `, SSL encryption` on PG 14+, `, SSL off` /
`, SSL on` before that. So the regex matches essentially all of them.

Measured, not argued. I added a role with no matching `host` line on a server with **SSL
entirely off and no `hostssl` rule anywhere**, i.e. a pure host-based-access omission with
no TLS involved:

```
  code=28000 name=error severity=FATAL
  no pg_hba.conf entry for host "10.89.4.8", user "qctls", database "mercur", no encryption
  PREFLIGHT FAIL: tls
```

A second, independent reproduction fell out of a broken `pg_hba.conf` file permission
during the same session (`/tmp/repro502/qc2/F2.log`): same `28000`, same `tls` verdict, and
the report on the two lines above it reads `sslmode=none protocol_reply=N` — the README's
own advice for `tls` ("compare `sslmode=` and `protocol_reply=`") yields a contradiction.

This is not a marginal false positive. On a managed Postgres — which is the deployment shape
this runbook is written for — a source-network or per-user `pg_hba` restriction is *more*
likely than a TLS posture mismatch. Dev has traded "TLS mismatch reported as auth" for
"access-control failure reported as tls", at the same cost, and §1.2's mutual exclusivity
(V6 vs V7) is not actually achieved.

**Minimum change:** gate the `tls` branch on evidence that TLS is even possible. The wire
byte is already known at the call site and is the free discriminator: a server that answered
`N` cannot have a TLS posture problem. Pass `wire.byte` into `classify` and make `28000`:

- `protocol_reply=S` **and** a TLS-shaped message → `tls`;
- message matches `/pg_hba\.conf/i` and `protocol_reply=N` → **not** `tls` and not `auth`;
  this is host-based-access, and it deserves its own token (the verbatim message is already
  printed, so the token only has to stop pointing at the wrong subsystem);
- otherwise → `auth`.

Also correct `README.md:636`, which still documents `28000` under `auth` and so contradicts
the shipped code in either direction.

### V2. Zero verdict tokens on the missing-`DATABASE_URL` path — **ACCEPTED, with a required one-line correction**

Dev weighed R3 (byte-comparable missing-env block) against §1.2's "exactly one line per run"
and kept R3. That is the right call on the merits: the banner is better output for a human
than a token, and R3 was an explicit gate.

But the claim is now false in two places that a responder will read as contract:
`entrypoint-api.sh:15` ("Exactly one line per run matches…") and `README.md:624` ("Every run
prints exactly one verdict line"). Confirmed by measurement — scenario I emits **zero** lines
matching `^ *PREFLIGHT (OK|FAIL:)`. A responder who greps token-first on a missing-env boot
gets nothing and has no way to tell "the preflight never ran" from "the log was truncated".

Take dev's own offer: append `  PREFLIGHT FAIL: environment` as the last line before the
`exit 1`. It is additive, so R3 still holds byte-for-byte for everything above it, it keeps
grep-first triage honest, and it makes the token set 13. If instead the token is not added,
both sentences above must be reworded — silently leaving them is not an option.

### V3. `database=`/`user=` redacted when they equal the password — **REJECTED; the defect is substantially worse than dev characterised it**

Dev framed this as a cosmetic loss on a degenerate local DB. It is not. `scrub()`
(`entrypoint-api.sh:180-185`) is a blind `split/join` applied to **every** emitted line —
including the literal report skeleton and the verdict token itself. The password is not
merely hidden where it appears as a value; it is deleted from static text that never
contained a secret.

Measured with `postgres://postgres:postgres@…`, the most common Postgres credential pair in
existence and the one this workspace's own database uses:

```
[preflight 3/4] *** wire protocol
  the port is open but nothing on it speaks the *** wire protocol:
  PREFLIGHT FAIL: no-***-protocol-response
```

`grep -c 'PREFLIGHT FAIL: no-postgres-protocol-response'` → **0**. The token documented in
`README.md:633` cannot be found in the log that emits it. With a short password the damage is
total — password `p` produced `PREFLIGHT FAIL: no-***ostgres-***rotocol-res***onse` and
shredded all 20 report lines (`/tmp/repro502/qc2/B.log`).

This defeats the deliverable of the whole cycle. §1.2 requires greppable, mutually exclusive
tokens; after scrubbing, the token is neither greppable nor guaranteed distinct — two
different tokens can collapse to the same string for an adversarial password. §6 R3 fires.

Dev's reasoning — "the scrubber cannot know which occurrence is the password" — is correct
about **values** and irrelevant to **literals**. The script authors every literal it prints
and knows for certain that `"  PREFLIGHT FAIL: "`, `"[preflight 3/4] postgres wire protocol"`
and the token vocabulary contain no secret. Scrubbing them buys nothing and costs the report.

**Minimum change:** never pass literal text through `scrub`. Scrub only interpolated values —
a `v(x)` helper applied at each interpolation point, with the whole-line scrub retained only
for driver-supplied strings (`err.message`, `factsError`). The non-negotiable subset, if the
full refactor is judged too large during an outage: the verdict line and the four phase
headers must be emitted unscrubbed. Both are closed-vocabulary constants, so G8 is unaffected
— scenario F must still show 0 matches for `SECRET`, `p%40ss` and `w0rd` afterwards.

The `database=`/`user=` masking dev actually asked about then becomes the residual, and in
that form it **is** acceptable: those two lines interpolate real URL-derived values, the
scrubber genuinely cannot tell them apart from the password, and erring toward redaction is
right. It is also self-explaining next to `password=set`.

## Minimum change required to ship

1. V3 — stop scrubbing literal text; at minimum emit the verdict line and phase headers
   unscrubbed. Re-run scenario F to confirm no leak, and scenario B with
   `postgres://postgres:postgres@…` to confirm the token greps.
2. V1 — gate the `28000` → `tls` branch on `protocol_reply=S`; give the `pg_hba` case its own
   token; fix `README.md:636`.
3. V2 (strongly recommended, one line) — emit `PREFLIGHT FAIL: environment` before the
   missing-env `exit 1`, or reword `entrypoint-api.sh:15` and `README.md:624`.

Nothing else needs to change. Everything in §2, §3 and §4 other than the above is verified
passing, and the V4/V6/V10 discriminator — the reason this cycle exists — works: B, E and E2
produce three different verdicts from three failures that a plain `SELECT 1` probe cannot
tell apart.

## Recorded, not acted on (out of scope)

- **`CLAUDE.local.md`'s "the API cannot finish migrations under podman on macOS" is
  falsified.** Independently reproduced by QC in scenario A: preflight → `Running
  migrations` → `Migrations completed` → `Server is ready on port: 9000` (log
  `/tmp/repro502/qc2/A.log:310`). Caveat: this was with `--network host` against a
  published `mercur-postgres`; the original claim may still hold for the default bridge
  network path. The note needs correcting with that qualifier, in a separate change.
- **`deploy/dokploy/README.md:530`** still reports "API full migration on this host |
  **blocked**". Same falsification, same caveat. Not touched here because it is outside the
  F3/F4 scope this cycle gated.

## Minor observations (not gates, no action required)

- `entrypoint-api.sh:529` prints `see the PREFLIGHT FAIL token above` on stderr. It does not
  match `^ *PREFLIGHT (OK|FAIL:)`, so the contract holds, but a naive
  `grep -F 'PREFLIGHT FAIL'` counts two lines.
- `TMPDIR` pointing at a non-existent directory makes `cat > "$PREFLIGHT_JS"` fail with a
  raw shell error and exit 2, no verdict token. `TMPDIR` is unset in the image, so `/tmp` is
  always used; honest failure, low value to harden.
- The temp file is removed on **both** the success and failure branches (`:526`, `:528`), but
  not on a signal — a `SIGTERM` mid-probe leaves `/tmp/mercur-preflight.js` behind in a
  container that is being destroyed anyway. Harmless.
- `/tmp` is `drwxrwxrwt` and the entrypoint runs as uid 0, so `cat >` through a pre-planted
  symlink would be a root write primitive. Not exploitable today: no unprivileged process
  exists in the container before the entrypoint and nothing mounts a shared `/tmp`. It stops
  being true the moment someone adds a non-root user or a shared tmp volume — `mktemp` or an
  `rm -f` before the redirect would close it permanently.

## Environment restored

`mercur-postgres` and `mercur-redis` are the only containers running. The probe roles
`qctls` and `qcsec` are dropped, `pg_hba.conf` is back to its original content **and** its
original `postgres:postgres 0600` ownership (a `sed -i` during the V1 test left it root-owned
and unreadable by the server; that is what produced the second `28000` reproduction, and it
has been repaired and reverified with a live authenticated connection). Both blackhole
listeners are killed.
