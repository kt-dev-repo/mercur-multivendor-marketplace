# Deploying as four separate Dokploy Applications

**Use this on a small host.** One Compose stack builds all four services at once
and that is what kept taking the control plane down: the server is 3 vCPU, and
four concurrent builds leave nothing to schedule Traefik or the Dokploy panel on.

Four independent Applications mean **you choose when each one builds**, one at a
time, and a redeploy of the storefront does not rebuild the API.

> If you can build in CI instead, do that — it is strictly better and the server
> compiles nothing. See README §1a. This document is the "build on the server,
> but safely" path.

---

## 0. Build them one at a time

The whole point is lost if two run together. Deploy in this order, waiting for
each to finish:

**api → storefront → admin → vendor**

API first, because the storefront and dashboards bake the API URL into their
bundles and the publishable key does not exist until the database is seeded.

---

## 1. Prerequisites

Create these first, as Dokploy **Database** services, and copy each one's
**internal** hostname:

| Service | Used by | Note |
|---|---|---|
| PostgreSQL 16 | api | `DATABASE_URL` |
| Redis 7 | api | `REDIS_URL` |

All four Applications and both databases must sit on the **same Docker network**
(`dokploy-network` by default). `depends_on` does not work across Dokploy
services, which is why the API entrypoint waits for both before migrating.

---

## 2. The four Applications

Every one: **Source = GitHub**, repo `kt-dev-repo/mercur-multivendor-marketplace`,
branch `main`, **Build Type = Dockerfile**, **Docker Context Path = `.`** (the
repository root — the Dockerfiles copy the whole workspace and will fail otherwise).

| App | Dockerfile Path | Build Stage | Port | Domain |
|---|---|---|---|---|
| `mercur-api` | `deploy/dokploy/Dockerfile.api` | — | 9000 | `api.example.com` |
| `mercur-storefront` | `deploy/dokploy/Dockerfile.storefront` | — | 3000 | `shop.example.com` |
| `mercur-admin` | `deploy/dokploy/Dockerfile.dashboard` | **`admin`** | 80 | `admin.example.com` |
| `mercur-vendor` | `deploy/dokploy/Dockerfile.dashboard` | **`vendor`** | 80 | `vendor.example.com` |

The two dashboards share one Dockerfile and differ only by **Build Stage**.
Targeting a stage builds only that chain, so the admin image never compiles the
vendor package. Nothing is duplicated and nothing is wasted.

Enable Let's Encrypt on all four domains.

---

## 3. How the four wire together

Only the database traffic is internal. Everything else is **browser** traffic, so
those URLs must be the public ones — a browser cannot resolve a Docker hostname.

```
        browser
           |
        Traefik  ──────────────────────────────────────────────┐
           |                |               |                  |
     shop.example.com  admin.example.com  vendor.example.com  api.example.com
           |                |               |                  |
      storefront:3000   admin:80        vendor:80           api:9000
           |                |               |                  |
           └────────────────┴───────────────┴──── all call the PUBLIC api URL
                                                              |
                                                  dokploy-network (internal)
                                                              |
                                                   postgres:5432   redis:6379
```

| From | To | Value | When it is read |
|---|---|---|---|
| api | postgres | `DATABASE_URL` — **internal** hostname | runtime |
| api | redis | `REDIS_URL` — **internal** hostname | runtime |
| storefront (server) | api | `MEDUSA_BACKEND_URL` = public API URL | runtime |
| storefront (browser) | api | `NEXT_PUBLIC_*` | **build** |
| admin / vendor | api | `VITE_MERCUR_BACKEND_URL` = public API URL | **build** |
| api | storefront | `STOREFRONT_REVALIDATE_URL` | runtime |
| api | vendor | `MERCUR_VENDOR_URL` | runtime |

**The build-time ones are the trap.** `VITE_MERCUR_BACKEND_URL` and every
`NEXT_PUBLIC_*` are compiled into the JavaScript. Changing them in the Dokploy
Environment tab and restarting does nothing — you must **Redeploy (rebuild)**.

`api` must also allow all four origins or the browser blocks every call:
`STORE_CORS`, `ADMIN_CORS`, `VENDOR_CORS`, `AUTH_CORS` — exact scheme, no
trailing slash.

---

## 4. Environment per Application

Start from `deploy/dokploy/.env.example` and set only what each app needs.

### `mercur-api` (runtime)

```
DATABASE_URL=postgres://user:pass@<internal-postgres-host>:5432/mercur
REDIS_URL=redis://<internal-redis-host>:6379
JWT_SECRET=...
COOKIE_SECRET=...
STORE_CORS=https://shop.example.com
ADMIN_CORS=https://admin.example.com
VENDOR_CORS=https://vendor.example.com
AUTH_CORS=https://shop.example.com,https://admin.example.com,https://vendor.example.com
MERCUR_VENDOR_URL=https://vendor.example.com
STOREFRONT_REVALIDATE_URL=https://shop.example.com
STOREFRONT_REVALIDATE_SECRET=...
FILE_BACKEND_URL=https://api.example.com/static
ADMIN_EMAIL=...
ADMIN_PASSWORD=...
RUN_SEED=false          # true ONLY on a brand-new database, then back to false
WAIT_TIMEOUT=120
MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT=30000
BUILD_JOBS=2            # build-time
BUILD_HEAP_MB=6144      # build-time
```

Add a **persistent volume** `/app/static` if you use the local file provider.
Without it, uploads vanish on every redeploy. Not needed once `S3_BUCKET` is set.

### `mercur-storefront` (build-time — rebuild to change)

```
MEDUSA_BACKEND_URL=https://api.example.com
NEXT_PUBLIC_BASE_URL=https://shop.example.com
NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_...    # exists only after seeding
NEXT_PUBLIC_DEFAULT_REGION=de
NEXT_PUBLIC_VENDOR_URL=https://vendor.example.com
NEXT_PUBLIC_SITE_NAME=...
NEXT_PUBLIC_SITE_DESCRIPTION=...
NEXT_PUBLIC_STRIPE_KEY=pk_test_...
REVALIDATE_SECRET=...                         # must match the API
BUILD_JOBS=2
```

### `mercur-admin` and `mercur-vendor` (build-time)

```
VITE_MERCUR_BACKEND_URL=https://api.example.com
BUILD_JOBS=2
BUILD_HEAP_MB=6144
```

---

## 5. First deploy, in order

1. **api** — deploy with `RUN_SEED=true` against an empty database. Watch the
   logs for `Waiting for dependencies` → `Running migrations` → `Seeding`.
   Then set `RUN_SEED=false`. Check `https://api.example.com/health`.
2. **Read the publishable key** — Admin → Settings → Publishable API Keys, or:
   ```sql
   select token from api_key where type='publishable' and revoked_at is null;
   ```
3. **storefront** — set `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` to that value, then
   deploy. Without it the shop renders with no products.
4. **admin**, then **vendor**.

Re-check `https://api.example.com/health` after each build. If it stops
responding mid-build, the host is starved — lower `BUILD_JOBS` to 1.

---

## 6. Sizing on this host (3 vCPU / 19.5 GB)

| Setting | Value | Why |
|---|---|---|
| `BUILD_JOBS` | **2** | leaves one core for Traefik and the panel |
| `BUILD_HEAP_MB` | **6144** | fits comfortably in 19.5 GB |
| Deploys | **one at a time** | the reason for splitting the stack |

A wedged host answers ping and completes TCP handshakes but returns **zero
bytes** — kernel alive, userspace starved. Recover from the provider's console;
SSH usually will not answer either.

---

## 7. Redeploy matrix — what actually needs rebuilding

| Change | Rebuild |
|---|---|
| API code, workflows, overlays | api |
| `NEXT_PUBLIC_*`, publishable key, storefront code | storefront |
| `VITE_MERCUR_BACKEND_URL`, admin pages | admin |
| same, vendor pages | vendor |
| API runtime env (CORS, secrets, S3) | **restart only** |
| Domain added or changed | rebuild every app that bakes that URL |

This is the payoff: a storefront copy change no longer recompiles the Medusa
server.
