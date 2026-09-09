# LOCAL-SETUP.md — Mercur local runbook

Status legend: **[done]** verified in this workspace · **[pending]** planned,
not yet executed.

## 0. Baseline **[done]**

```
clone   https://github.com/mercurjs/mercur.git
commit  da34c523f27cb0c33bf3d5c08640a4894859897c
        chore: v2.3.4-canary.5 (#1493)  —  2026-09-08
tree    clean; identical to upstream/main
```

Remotes **[done]**:

```bash
git remote set-url origin https://github.com/kt-dev-repo/mercur-multivendor-marketplace.git
git remote add upstream https://github.com/mercurjs/mercur.git
git remote set-url --push upstream DISABLED
```

## 1. Prerequisites **[done]**

| Requirement | Needed | Present |
|---|---|---|
| Node | >= 20 | v24.19.0 |
| Bun | 1.3.8 (`packageManager`) | 1.3.11 |
| Docker | any | 29.7.2 |
| Postgres | >= 13 | via Docker |
| Redis | any | via Docker |

## 2. Data stores **[done — running]**

Postgres and Redis run as **two independent services**, one compose file each, so
either can be stopped, upgraded, or wiped without touching the other.

**Engine: Podman.** Podman Desktop owns `/var/run/docker.sock` on this machine —
the `default` docker context reports server `6.1.0 / linux-arm64 / fedora-44`, so
`docker compose` and `podman compose` both hit the same Podman engine. Either
command works; `podman` is the canonical one here.

```bash
podman compose -f docker-compose.postgres.yml up -d
podman compose -f docker-compose.redis.yml    up -d
```

`podman compose` delegates to the external `docker-compose` provider (that notice
is expected). Published ports are forwarded by `gvproxy`.

Verified on 2026-09-09 under Podman 6.1.0: `mercur-postgres` healthy
(PostgreSQL 16.15), `mercur-redis` healthy (`PONG`). They register as two
separate compose projects (`podman compose ls`).

| Service | Container | URL | Volume |
|---|---|---|---|
| Postgres 16 | `mercur-postgres` | `postgres://mercur:mercur@localhost:5432/mercur` | `mercur-pgdata` |

On first initialisation Postgres also runs `deploy/local/initdb/`, which creates
the `postgres` superuser the integration test harness requires.

| Redis 7 | `mercur-redis` | `redis://localhost:6379` | `mercur-redisdata` |

Per-service control:

```bash
podman compose -f docker-compose.redis.yml restart      # Redis only
podman compose -f docker-compose.postgres.yml logs -f   # Postgres only
podman compose -f docker-compose.postgres.yml down      # stop, keep data
podman compose -f docker-compose.postgres.yml down -v   # DESTROY data
```

Credentials and ports are overridable without editing the files —
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, `REDIS_PORT`.

Redis holds the cache, event bus, workflow engine, and locking provider
(`apps/api/medusa-config.ts`), so wiping it drops in-flight workflow state.
Appendonly persistence is enabled to reduce that risk.

### Using externally hosted services instead

Nothing in the repo depends on these compose files. To use a managed or already
running Postgres/Redis, skip this step and point `DATABASE_URL` and `REDIS_URL`
in `apps/api/.env` at them. For a managed Postgres that enforces TLS, append
`?ssl_mode=require`.

## 3. Environment files **[done]**

Both are gitignored upstream. `apps/api/.env` as listed below; the CORS lists are
widened because the upstream template targets ports the apps do not actually use.

```env
DATABASE_URL=postgres://mercur:mercur@localhost:5432/mercur
REDIS_URL=redis://localhost:6379
JWT_SECRET=supersecret
COOKIE_SECRET=supersecret
STORE_CORS=http://localhost:3000,http://localhost:8000
ADMIN_CORS=http://localhost:7000,http://localhost:7001,http://localhost:9000
VENDOR_CORS=http://localhost:7001,http://localhost:7002
AUTH_CORS=http://localhost:3000,http://localhost:7000,http://localhost:7001,http://localhost:7002,http://localhost:9000
MERCUR_VENDOR_URL=http://localhost:7002
STOREFRONT_REVALIDATE_URL=http://localhost:3000
STOREFRONT_REVALIDATE_SECRET=supersecret
FILE_BACKEND_URL=http://localhost:9000/static
```

`apps/storefront/.env.local` = copy of `.env.template`, with the publishable key
from step 5 and `NEXT_PUBLIC_DEFAULT_REGION=de`.

## 4. Install & build **[done]**

```bash
bun install     # 4316 packages, ~97s; bun.lock unchanged
bun run build   # turbo: 12/12 tasks OK, ~42s
bun run lint    # oxlint, clean
```

Turbo warns `no output files found for task @mercurjs/storefront#build` — an
upstream `turbo.json` `outputs` gap (it does not list `.next`). Harmless; the
Next build does produce output.

## 5. Database bring-up **[done]**

There is **no `bunx`** in this toolchain — use `bun x`.

```bash
cd apps/api
bun x medusa db:migrate                                    # 204 tables
bun run seed
bun x medusa user -e admin@mercur.local -p supersecret
```

Seed result: 1 region (Europe: gb/de/dk/se/fr/es/it), 5 sellers (all `open`),
50 products, **1144 offers**, plus a `Default Publishable API Key`.

The seed **does** create the publishable key — read it and wire it in:

```bash
podman exec mercur-postgres psql -U mercur -d mercur -tAc \
  "select token from api_key where type='publishable' and revoked_at is null;"
```

## 6. Run **[done]**

| App | Command | URL | Verified |
|---|---|---|---|
| API | `cd apps/api && bun run dev` | http://localhost:9000 | `/health` 200, ready in 4.0s |
| Storefront | `cd apps/storefront && bun run dev` | http://localhost:3000 | `/` → 307 → `/de`, 200, renders seeded products |
| Admin | `cd apps/admin-test && bun run dev` | http://localhost:7001 | 200 |
| Vendor | `cd apps/vendor && bun run dev` | http://localhost:7002 | 200 |

Do **not** use `scripts/dev.sh` — it hardcodes another machine's path and omits
the storefront.

## 7. Verification results **[done — all green]**

API, 2026-09-09:

| Check | Result |
|---|---|
| `GET /health` | 200 |
| `GET /store/products` (publishable key) | 200, count **50** |
| `GET /store/regions` | Europe → dk, fr, de, it, es, se, gb |
| `POST /auth/user/emailpass` | JWT issued |
| `GET /admin/sellers` | 5 sellers, all `open` |
| `GET /admin/commission-rates` / `/admin/orders` | 200 / 200 |
| `GET /vendor/products` unauthenticated | **401** (scoping enforced) |
| Cart: create → add offer ×2 | total **88 eur** |
| Storefront `/de` | 200, 419 KB, renders "Apex Pool Slides", no error overlay |

Suites:

| Suite | Result |
|---|---|
| `bun run lint` | clean |
| `bun run test:unit` | **13 passed / 13**, 3 suites |
| `integration-tests/http/collections/vendor` | **9 passed / 9** |
| `integration-tests/http/seller` (admin+vendor+store) | **180 passed / 180**, 85s |

### Cart line items take `offer_id`, not `variant_id`

The single most surprising API difference from stock Medusa:

```bash
# fails: "Field 'offer_id' is required; Unrecognized fields: 'variant_id'"
# correct — offer id comes from product.variants[].offer_id
curl -X POST "http://localhost:9000/store/carts/$CART/line-items" \
  -H "x-publishable-api-key: $PK" -H 'Content-Type: application/json' \
  -d '{"offer_id":"offer_...","quantity":2}'
```

### Two upstream issues worked around without editing tracked files

1. **`bun run test:unit` cannot resolve `@swc/jest`.** The script runs
   `jest --rootDir ..`, so Jest looks for the transform at the repo root, but bun
   installs `@swc/jest` only into `integration-tests/node_modules` and
   `apps/api/node_modules`. **Fixed by overlay 002** — apply it instead of
   symlinking anything:

   ```bash
   ./deploy/overlays/apply.sh --only 002
   ```

   (A `node_modules/@swc` symlink also works but is wiped by a clean install.)

2. **Integration tests need a `postgres` superuser.** `integration-tests/.env.test`
   hardcodes `postgres:postgres@localhost:5432`, and `@medusajs/test-utils` builds
   its connection from `DB_*`, not `DATABASE_URL`. The runner creates and drops
   databases, so the role needs `SUPERUSER CREATEDB`.

   **Handled automatically.** `docker-compose.postgres.yml` mounts
   `deploy/local/initdb/` into `/docker-entrypoint-initdb.d`, so the role is
   created when the data directory is first initialised — no manual step, and no
   edit to the tracked `.env.test`.

   It runs **only on first init**. On a volume created before this was added,
   add the role once by hand:

   ```bash
   podman exec mercur-postgres psql -U mercur -d mercur \
     -c "CREATE ROLE postgres LOGIN SUPERUSER CREATEDB PASSWORD 'postgres';"
   ```

Always pass a pattern to the HTTP suite — never run it bare:

```bash
bun run test:integration:http -- integration-tests/http/seller
```

Jest prints `haste module naming collision` warnings for `templates/` and
`apps/storefront/.next/standalone`. Cosmetic; tests still pass.

## 8. Publish **[done]**

```bash
git push -u origin main
```

`main` = upstream history at `da34c523f` plus one commit adding local tooling.
No upstream-tracked file is modified, so the diff against our upstream base
shows only added files and `git merge upstream/main` cannot conflict.

```bash
# Verify the invariant. Compare against the upstream commit we are BASED on,
# not upstream/main — once upstream advances, its tip differs from our base and
# a plain `git diff upstream/main` reports upstream's own changes as if they
# were ours.
git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"
# empty output = no upstream-tracked file was modified
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| CORS error in a dashboard/storefront | port missing from the matching `*_CORS` in `apps/api/.env` |
| Storefront empty | publishable key missing, or region ≠ `de` |
| `db:migrate` connection refused | `podman compose -f docker-compose.postgres.yml ps` — service down or unhealthy |
| `bunx: command not found` | use `bun x` |
| `@swc/jest ... not found` | `./deploy/overlays/apply.sh --only 002` |
| unknown product/seller URL returns 200 | `./deploy/overlays/apply.sh --only 001` (images apply it automatically) |
| `Field 'offer_id' is required` | use `offer_id` from `product.variants[].offer_id`, not `variant_id` |
| Duplicate `@medusajs/*` versions | root `overrides` pin 2.20.1 — never bump per-workspace |
| Port already in use | `lsof -ti tcp:<port>` then kill |
