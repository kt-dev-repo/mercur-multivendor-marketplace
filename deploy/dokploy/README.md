# Deploying Mercur on Dokploy

Deploys the whole marketplace as one Dokploy **Compose** service: Postgres,
Redis, the Medusa API, the Next.js storefront, and the vendor + admin dashboards.

Every file here is additive. No upstream file is modified, so `git merge upstream/main`
stays conflict-free.

---

## 0. Before you start — read this

Three properties of this stack cause most failed deploys. They are not Dokploy
quirks; they are how the apps are built.

1. **The storefront and dashboards bake their URLs in at build time.**
   `NEXT_PUBLIC_*` and `VITE_MERCUR_BACKEND_URL` are compiled into the JS bundle.
   Changing them later requires a **Redeploy (rebuild)** — restarting does nothing.

2. **The publishable API key does not exist until the database is seeded.**
   So the first deploy is deliberately two passes: bring the API up, take the key,
   then rebuild the storefront with it. Step 6.

3. **Bun installs, Node runs.** The repo ships `bun.lock` and bun workspaces, so
   bun is the only correct installer — but `medusa build` **crashes under the bun
   runtime on Linux** (MikroORM reads decorator positions from stack traces via
   source-map-support and throws ``` `column` must be greater than or equal to 0 ```).
   Every image therefore uses `node:22-bookworm-slim` with the bun binary copied
   in, and invokes medusa/vite/next through Node. Do not "simplify" these back to
   an `oven/bun` runtime.

4. **The API image overlays workspace packages over the registry ones.**
   `apps/api/package.json` declares `"@mercurjs/core": "*"`. Installing inside the
   Medusa build output resolves that from npm and can pull an **older published**
   `@mercurjs/core` than this checkout. That happened here: published `2.3.3`
   carries a core-flows patch manifest capped at `<2.19.0`, while this repo pins
   `@medusajs/core-flows` `2.20.1`. `withMercur()` then throws at config load and
   the server never boots:

   ```
   [mercur] Patch "@medusajs+core-flows@2.18.0.patch" was generated against
   @medusajs/core-flows >=2.17.0 <2.19.0, but 2.20.1 is what this project resolves
   ```

   `Dockerfile.api` fixes this by copying the workspace `@mercurjs/{core,types,client,cli}`
   over the installed copies. **Do not remove that overlay step.** If you ever see
   the error above, the overlay did not run.

---

## 0b. Overlays are applied during the image build

`main` never modifies an upstream file. Fixes to upstream code live as patches in
`deploy/overlays/` and each image runs `deploy/overlays/apply.sh` while building,
so deployments get them without the repository carrying them.

You will see this in the build log:

```
  applied     001-storefront-not-found-status.patch
  applied     002-jest-swc-transform-resolution.patch
  skipped     003-dashboard-ports-docs.patch  (targets not in this tree)
```

`skipped` is normal — images do not copy `docs/` or `CLAUDE.md`. A **`CONFLICT`
line fails the build on purpose**: it means upstream changed underneath a patch,
and the patch must be regenerated rather than forced. See
`deploy/overlays/README.md`.

## 1. Requirements

- A Dokploy server with Traefik running (the default).
- Four DNS A records pointing at that server:

  | Host | Serves |
  |---|---|
  | `api.example.com` | Medusa API |
  | `shop.example.com` | Storefront |
  | `vendor.example.com` | Vendor dashboard |
  | `admin.example.com` | Admin dashboard |

- **6 GB RAM minimum** on the build host, 8 GB comfortable. This is not padding:
  `@mercurjs/vendor` emits an ~8 MB ESM chunk and tsup generates its `.d.ts` in a
  worker thread that dies with `ERR_WORKER_OUT_OF_MEMORY` at the default heap.
  `Dockerfile.dashboard` sets `NODE_OPTIONS=--max-old-space-size=6144` to survive
  it; the host still has to have that memory to give.
- Roughly **8 GB free disk** for the image layers and the bun install cache.

## 2. Create the Compose service

1. Dokploy → **Create Service** → **Compose**.
2. Provider: **GitHub** (or Git), repository
   `kt-dev-repo/mercur-multivendor-marketplace`, branch `main`.
3. **Compose Path**: `docker-compose.dokploy.yml`
4. Leave the build context alone — the Dockerfiles expect the **repo root**.

## 3. Environment

Copy `deploy/dokploy/.env.example` into the service's **Environment** tab and
fill every `CHANGE_ME`.

Generate secrets separately, never reuse one value:

```bash
openssl rand -base64 32   # JWT_SECRET
openssl rand -base64 32   # COOKIE_SECRET
openssl rand -base64 32   # REVALIDATE_SECRET
```

For the **first** deploy set:

```env
RUN_SEED=true
NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=
```

`RUN_SEED=true` creates 5 demo sellers, 50 products and ~1144 offers. Skip it if
you want an empty catalogue — but then create your own publishable key in step 6.

## 4. Attach domains

In the service's **Domains** tab, one entry per app. The container port matters:

| Service | Host | Container port | HTTPS |
|---|---|---|---|
| `api` | `api.example.com` | **9000** | on |
| `storefront` | `shop.example.com` | **3000** | on |
| `vendor` | `vendor.example.com` | **80** | on |
| `admin` | `admin.example.com` | **80** | on |

Enable **Let's Encrypt** on all four. The compose file deliberately publishes no
host ports — Traefik reaches the containers over the internal network.

## 5. First deploy

Hit **Deploy**. Expect **10–20 minutes**: it installs the full monorepo and builds
four images.

The API entrypoint runs migrations before serving traffic, then optionally seeds,
then ensures the admin user. Watch the `api` logs for:

```
→ Running migrations
→ Seeding (RUN_SEED=true)
→ Ensuring admin user admin@example.com
✔ Server is ready on port: 9000
```

Verify:

```bash
curl https://api.example.com/health          # -> 200
```

At this point the storefront is up but shows **no products** — expected, it has
no publishable key yet.

## 6. Wire the publishable key (required, once)

The seed creates a `Default Publishable API Key`. Read it from the database —
in Dokploy open a **Terminal** on the `postgres` container:

```bash
psql -U mercur -d mercur -tAc \
  "select token from api_key where type='publishable' and revoked_at is null;"
```

You get a `pk_…` value. Then:

1. Put it in the Environment tab as `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`.
2. Set `RUN_SEED=false` (leaving it true re-seeds duplicates on every deploy).
3. **Redeploy** — a rebuild, because the key is compiled into the bundle.

If you skipped seeding, create a key in the admin dashboard first
(Settings → Publishable API Keys), linked to the default sales channel.

## 7. Verify the deployment

```bash
curl -s https://api.example.com/health
curl -s -H "x-publishable-api-key: pk_…" \
  "https://api.example.com/store/products?limit=1"      # count > 0
curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/vendor/products
                                                        # MUST be 401
curl -sI https://shop.example.com/                      # 307 -> /de
```

Then in a browser:

- `https://shop.example.com` — products render, add-to-cart works
- `https://admin.example.com` — log in with `ADMIN_EMAIL`, sellers list is populated
- `https://vendor.example.com` — seller login

A `401` on `/vendor/products` without a token is **correct** — it proves seller
scoping is enforced.

## 8. After a successful deploy

- Remove `ADMIN_PASSWORD` from the environment.
- Confirm `RUN_SEED=false`.
- Take a Postgres backup (Dokploy → service → Backups).

---

## Production hardening

**File storage.** The API uses Medusa's **local** file provider, writing to the
`uploads` volume. That volume keeps uploads across redeploys, but it does not
survive moving hosts and does not scale past one API replica. For real traffic,
switch to S3 in `apps/api/medusa-config.ts` — note that is an **upstream-tracked
file**, so changing it breaks the clean-merge property. Prefer a small overlay or
an upstream PR.

**Payments.** `pp_system_default` is a stub that authorises everything. Configure
Stripe (and Stripe Connect for payouts, `packages/providers/payout-stripe-connect`)
before taking money.

**Scaling.** The API is stateful in one respect: scheduled jobs run on **every**
instance (payout capture every 15 min, payouts daily at 01:00 UTC). Running more
than one replica double-fires them. Keep `api` at 1 replica unless you add leader
election.

**Redis.** Backs the cache, event bus, workflow engine and locking. Wiping it
drops in-flight workflow state. Appendonly persistence is on.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Patch … generated against >=2.17.0 <2.19.0, but 2.20.1` | The workspace overlay in `Dockerfile.api` did not run. Rebuild without cache. |
| Storefront renders but has no products | `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` empty or set after the build. Set it and **rebuild**. |
| Storefront empty and region looks wrong | `NEXT_PUBLIC_DEFAULT_REGION` must match a seeded region. The seed creates one region covering `gb de dk se fr es it`; default is `de`. |
| CORS errors in browser console | The exact origin is missing from `STORE_CORS` / `ADMIN_CORS` / `VENDOR_CORS` / `AUTH_CORS`. Include the scheme, no trailing slash. |
| Dashboard loads but every API call fails | `VITE_MERCUR_BACKEND_URL` was empty at build time. Set `API_PUBLIC_URL` and rebuild. |
| Dashboard 404s on refresh of a sub-route | SPA fallback missing — `nginx-spa.conf` must be present in the image. |
| `db:migrate` cannot connect | `postgres` unhealthy. Check its logs and that `POSTGRES_*` match `DATABASE_URL`. |
| Build OOM-killed | Under 4 GB RAM. Increase the build host, or build images in CI and deploy by tag. |
| Uploaded images 404 | `FILE_BACKEND_URL` must be `${API_PUBLIC_URL}/static`. |
| Seed data duplicated | `RUN_SEED` left `true`. Set false and redeploy. |
| `ERR_WORKER_OUT_OF_MEMORY` during build | Build host under 6 GB RAM. |
| `Parsing error: The keyword 'export' is reserved` | Root `eslint.config.mts` missing from the build context. |
| ``` `column` must be greater than or equal to 0 ``` | Something is running medusa under bun instead of Node. |
| `File /app/src/scripts/seed.ts doesn't exist` | Use the compiled `seed.js` path; the entrypoint handles this. |

## What was verified before shipping these files

Every image here was built and run against real Postgres and Redis, not just
written:

| Check | Result |
|---|---|
| `Dockerfile.api` builds | yes; overlay logs `overlaid @mercurjs/core = 2.3.4-canary.5` |
| API container boots on a **fresh** database | migrations → seed → admin user → `Server is ready` |
| Seed inside the container | 5 sellers, 50 products, 1074 offers, 1 publishable key |
| `GET /health` | 200 |
| `GET /store/products` with the seeded key | count 50 |
| `GET /vendor/products` unauthenticated | **401** — seller scoping enforced |
| Admin login (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) | 200, token issued |
| `Dockerfile.storefront` builds | yes, Next standalone |
| Storefront container against the API container | `/de` 200, **4 product cards rendered**, no error overlay |
| Build args baked in | page title reflected `NEXT_PUBLIC_SITE_NAME` |
| `Dockerfile.dashboard` builds (`APP=vendor`) | yes |
| `Dockerfile.dashboard` builds (`APP=admin-test`) | yes; distinct bundle from vendor (different asset hashes) |
| Dashboard serves a missing asset | 404, not an index.html fallback |
| Overlays applied in every image build | 001 + 002 applied, 003 correctly skipped |
| 404s in the **production** storefront image | unknown product / seller / collection → **404**; `/de`, existing product, existing seller → **200** |
| Dashboard SPA fallback on a deep route | 200, not 404 |
| `VITE_MERCUR_BACKEND_URL` baked into the bundle | found in `assets/*.js` |

## Known upstream issues affecting deploys

1. **`medusa build` emits TypeScript errors** from `apps/api/src/scripts/**`
   (9 errors across 6 seed/dev scripts, e.g. `seed-reviews.ts`, `seed-reservations.ts`).
   They do not affect runtime — Medusa still emits a complete server, verified
   booting and serving. `Dockerfile.api` tolerates them and then asserts
   `.medusa/server/medusa-config.js` exists, so a genuinely broken build still fails.

2. **`apps/api`, `apps/admin-test` and `apps/vendor` declare no `build` script.**
   The Dockerfiles call `medusa build` and `vite build` directly instead. Note the
   binaries are NOT hoisted to the repo root under bun's isolated layout — they
   live in each workspace's own `node_modules/.bin`.

3. **`apps/storefront` has no local ESLint config** and relies on the root
   `eslint.config.mts`. If that file is missing from the build context,
   `next build` lints every `.ts` file with the default parser and fails with
   `Parsing error: The keyword 'export' is reserved`. The Dockerfiles copy it in.

4. **`better-sqlite3` breaks `bun install` in slim images.** It is an optional
   peer of `@mikro-orm/knex` (with libsql and mariadb); Mercur uses Postgres and
   never loads it, and it is absent from the built server's dependencies — but its
   install script runs node-gyp, which needs python3/make/g++. The images pass
   `--ignore-scripts`; nothing in them needs a lifecycle script.

5. **The seed script is compiled in the built server.** `package.json` still says
   `medusa exec ./src/scripts/seed.ts`, but the build output only contains
   `seed.js`, so the packaged script path fails. `entrypoint-api.sh` prefers `.js`
   and falls back to `.ts`.

6. **Storefront soft-404s** — unknown product, seller and collection handles
   returned HTTP 200 instead of 404. **Fixed by overlay `001`**, applied in the
   image build, so deployments serve correct status codes.

7. **`bun run test:unit` cannot resolve `@swc/jest`** — **fixed by overlay `002`**.

8. **Wrong dashboard ports in the upstream docs** (admin 7000 / vendor 7001 are
   the `preview` ports; `dev` binds 7001 / 7002) — **fixed by overlay `003`**,
   which applies in a checkout but is skipped in images.
