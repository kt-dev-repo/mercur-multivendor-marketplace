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

## 2. Data stores **[pending]**

```bash
docker compose -f docker-compose.local.yml up -d
docker compose -f docker-compose.local.yml ps        # both healthy
```

`postgres://mercur:mercur@localhost:5432/mercur` · `redis://localhost:6379`

## 3. Environment files **[pending]**

Both paths are already gitignored upstream — safe to create.

`apps/api/.env` (based on `templates/basic/packages/api/.env.template`, with CORS
widened to the ports actually used):

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

> Why the template values were widened: it ships `STORE_CORS=...:8000` (storefront
> is on 3000) and `VENDOR_CORS=...:7001` (vendor actually binds 7002).

`apps/storefront/.env.local` — copy `apps/storefront/.env.template`, keep
`NEXT_PUBLIC_DEFAULT_REGION=de` (matches the seed), fill the publishable key from step 5.

## 4. Install & build **[pending]**

```bash
bun install
bun run build
```

## 5. Database bring-up **[pending]**

```bash
cd apps/api
bunx medusa db:migrate
bun run seed                      # sales channel, regions gb/de/dk/se/fr/es/it, tax, shipping
bunx medusa user -e admin@mercur.local -p <password>
```

Then create a **publishable API key** linked to the default sales channel via the
Admin API (the seed does not create one) and put it in
`apps/storefront/.env.local` as `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`.

## 6. Run **[pending]**

| App | Command (from repo root) | URL |
|---|---|---|
| API | `cd apps/api && bun run dev` | http://localhost:9000 |
| Storefront | `cd apps/storefront && bun run dev` | http://localhost:3000 |
| Admin | `cd apps/admin-test && bun run dev` | http://localhost:7001 |
| Vendor | `cd apps/vendor && bun run dev` | http://localhost:7002 |

Do **not** use `scripts/dev.sh` — it hardcodes another machine's path and omits
the storefront.

## 7. Smoke test **[pending]**

1. `GET http://localhost:9000/health` → 200
2. Storefront lists seeded products, region `de`
3. Add to cart succeeds
4. Admin login at :7001
5. Vendor login at :7002

## 8. Publish **[done]**

```bash
git push -u origin main
```

`main` = upstream history at `da34c523f` plus one commit adding local tooling.
No upstream-tracked file is modified, so `git diff upstream/main` shows only
added files and future `git merge upstream/main` cannot conflict.

## Troubleshooting

| Symptom | Fix |
|---|---|
| CORS error in a dashboard/storefront | port missing from the matching `*_CORS` in `apps/api/.env` |
| Storefront empty | publishable key missing, or region ≠ `de` |
| `db:migrate` connection refused | containers not up / not healthy |
| Duplicate `@medusajs/*` versions | root `overrides` pin 2.20.1 — never bump per-workspace |
| Port already in use | `lsof -ti tcp:<port>` then kill |
