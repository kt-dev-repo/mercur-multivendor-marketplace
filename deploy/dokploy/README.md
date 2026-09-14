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

- **6 GB RAM minimum** on the build host, 8 GB comfortable — and that is the
  figure for **one** image at a time. `@mercurjs/vendor` emits an ~8 MB ESM chunk
  and tsup generates its `.d.ts` in a worker thread that dies with
  `ERR_WORKER_OUT_OF_MEMORY` at the default heap, so the dashboard build raises
  the ceiling via `BUILD_HEAP_MB` (default 4096).

  **Set `COMPOSE_PARALLEL_LIMIT=1` before your first deploy.** Compose builds all
  four services concurrently by default; two monorepo installs, a `next build`
  and two vite builds at once will exhaust any modest VPS. See §1a.
- Roughly **8 GB free disk** for the image layers and the bun install cache.

## 1a. Do not let the build kill the server

This stack has taken a Dokploy host down, so treat this as required reading.

**What happens.** All four services carry a `build:` block and Compose builds
them concurrently: two monorepo installs, a `next build` and two vite builds,
all at once.

The usual failure is **CPU and disk I/O starvation, not memory**. Four parallel
builds peg every vCPU, and Traefik and the Dokploy panel then cannot get
scheduled long enough to answer a request. Observed on a 19.5 GB / 144 GB host:
CPU pinned at 100%, memory only 13 GB of 19.5 used, disk at 27% — and the panel
was still unreachable.

Memory is the second failure mode, and it dominates on smaller hosts. Peak
demand is the *sum* of all four builds, not the single-image figure above. When
the host runs out, the Linux OOM-killer chooses its victim by score **across the
whole machine**, and Traefik and the Dokploy panel are candidates. Either way
you lose the control plane, not just the deploy.

**Why an over-large heap ceiling makes it worse.** `--max-old-space-size` above
available RAM is worse than no ceiling at all: Node will not fail at its own
limit, it keeps allocating until the kernel intervenes — and the kernel may kill
something else. Size `BUILD_HEAP_MB` to the host so the build fails cleanly.

**How to recognise it.** A host in this state still answers ping and still
completes TCP handshakes on 80/443/3000, but never returns a byte:

```bash
ping -c3 <host>                 # replies
nc -z <host> 443                # succeeds
curl -m 30 http://<host>:3000/  # connects in ms, then zero bytes until timeout
```

Kernel alive, userspace wedged. SSH is usually unreachable too, so recover from
the provider's web console or serial console, or hard-reboot from the panel.

**Prevention, in order of effectiveness:**

1. **Build one image at a time** — set `COMPOSE_PARALLEL_LIMIT=1` in the Dokploy
   service Environment. Necessary, and it costs only build time.
2. **Cap the parallelism inside each build** — set `BUILD_JOBS` to leave at least
   one core free (1 on 2 vCPUs, 2 on 3-4, `cores - 2` above that). **This is the
   step people miss, and on a small host step 1 alone will not save you:**
   `turbo.json` sets concurrency 20, and esbuild's Go runtime and SWC's rayon
   pool each size themselves to the core count, so a *single* image build can
   still peg every vCPU and starve Traefik and the panel.
3. **Size `BUILD_HEAP_MB` to the host** — 2048 at 4 GB, 4096 at 8 GB, 6144 at
   16 GB+ (the default).
4. **Keep the `mem_limit` values** in the compose file, but do not set them too
   low. They bound the running containers so a leak kills one container rather
   than the host — yet an `api` capped under ~3 GB can be OOM-killed by Docker
   during migrations or seeding, which presents as an unexplained crash-loop.
   The defaults suit a 16-20 GB host; halve them for 8 GB.
5. **Add swap** as a safety net — it turns a hard OOM into slowness:
   ```bash
   sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
   sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```
6. **On 3 vCPUs or fewer, or under 8 GB, do not build on the server at all.** Build in CI,
   push to a registry, and have Dokploy deploy the tag. Replace each `build:`
   block with `image: your-registry/mercur-<service>:<tag>`.

## 1b. Architecture: what talks to what

Postgres and Redis are **separate Dokploy services**. This stack contains only
the four application services and reaches the databases over Dokploy's shared
Docker network.

```
                    Traefik (Dokploy, TLS + routing)
   shop.example.com   admin.example.com  vendor.example.com  api.example.com
          |                  |                  |                  |
     storefront:3000     admin:80          vendor:80           api:9000
          |                  |                  |                  |
          +------------------+------------------+------------------+
                    all browser traffic goes to API_PUBLIC_URL
                                       |
                                    api:9000
                                       |
                     dokploy-network (internal, no TLS)
                          |                       |
                 postgres:5432              redis:6379
              (separate Dokploy service)  (separate Dokploy service)
```

**Two different kinds of connection, and mixing them up is the usual failure:**

| Hop | Address to use | Why |
|---|---|---|
| Browser → storefront / dashboards / API | **public** `https://…` domains | real client traffic, must be TLS |
| Storefront (server-side) → API | **public** `API_PUBLIC_URL` | it renders URLs the browser will reuse |
| Dashboards → API | **public** `API_PUBLIC_URL` | the bundle runs in the browser |
| **API → Postgres / Redis** | **internal hostname**, e.g. `postgres:5432` | stays inside the server, never hits Traefik |

`localhost` in `DATABASE_URL` or `REDIS_URL` refers to the **API container
itself** and is the single most common cause of a failed deploy.

### Optional: keep storefront SSR traffic internal

`MEDUSA_BACKEND_URL` is read only by the storefront's **server** code
(`'use server'` modules and `middleware.ts`). It is deliberately not
`NEXT_PUBLIC_`, so it is never inlined into the browser bundle — the one helper
that would have leaked it into markup, `getImageUrl`, is dead code and imported
nowhere.

So it may point at the API **internally** instead of at the public domain:

```yaml
    environment:
      MEDUSA_BACKEND_URL: http://api:9000
```

That keeps server-side rendering off Traefik and works even when the host cannot
resolve its own public domain (no hairpin NAT). The default stays
`${API_PUBLIC_URL}` because it is unconditionally correct: `api` is a compose
service alias, and on a *shared* network another stack exposing the same service
name could shadow it. Switch only if you know the alias is unambiguous, and
change nothing else — the browser never uses this value.

### Build-time vs runtime

| Variable | When it takes effect |
|---|---|
| `NEXT_PUBLIC_*`, `VITE_MERCUR_BACKEND_URL`, `API_PUBLIC_URL` (as a build arg) | **build** — changing it needs a Redeploy/rebuild |
| `DATABASE_URL`, `REDIS_URL`, `*_CORS`, `S3_*`, `JWT_SECRET`, `MEDUSA_BACKEND_URL` | **runtime** — a restart is enough |

## 1c. Create Postgres and Redis first

1. Dokploy → **Create Service → Database → PostgreSQL** (16+). Note the
   generated user, password, database name and **internal hostname**.
2. Dokploy → **Create Service → Database → Redis**.
3. Confirm the shared network name on the server:

   ```bash
   docker network ls | grep dokploy
   ```

   It is normally `dokploy-network`. If yours differs, set `DOKPLOY_NETWORK`.

4. Build the URLs for the Environment tab:

   ```env
   DATABASE_URL=postgres://<user>:<password>@<postgres-internal-host>:5432/<db>
   REDIS_URL=redis://<redis-internal-host>:6379
   # with a Redis password:
   # REDIS_URL=redis://:<password>@<redis-internal-host>:6379
   ```

There is **no `depends_on`** across Dokploy services, so nothing guarantees the
databases are up before the API starts. The API entrypoint therefore waits for
both (TCP) before running migrations, up to `WAIT_TIMEOUT` seconds (default 120)
and logs which one it could not reach.

> Prefer the databases bundled into this stack instead? Use
> `docker-compose.dokploy-bundled.yml`, which includes them and needs no shared
> network — simpler, but the data lives and dies with the app stack.

## 2. Create the Compose service

1. Dokploy → **Create Service** → **Compose**.
2. Provider: **GitHub** (or Git), repository
   `kt-dev-repo/mercur-multivendor-marketplace`, branch `main`.
3. **Compose Path**: `docker-compose.dokploy.yml`
   (or `docker-compose.dokploy-bundled.yml` to run the databases inside the stack)
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

The seed creates a `Default Publishable API Key`. Read it from the database — in
Dokploy open a **Terminal** on your **Postgres service** (it is a separate
service, not part of this stack):

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

**File storage.** Set `S3_BUCKET` and the API switches from the local provider to
S3 — no code change, no rebuild, just environment. Overlay `004` makes the
provider selection env-driven; see `deploy/overlays/README.md` for the full
variable list.

Do this before real traffic. The local provider writes to the `uploads` volume,
which survives redeploys but not a host move, cannot be shared across API
replicas, and bakes the public origin into every stored URL — so changing your
domain breaks every existing image.

Works with AWS S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2 and MinIO.
Two settings catch people out: everything except real AWS needs `S3_ENDPOINT`,
and buckets with AWS Object Ownership `BucketOwnerEnforced` (the default since
2023) or R2 reject ACL headers — send `S3_ACL=false` there.

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
| API logs `cannot reach postgres` / `cannot reach redis` | The stack and the database service are not on the same network, or the URL uses `localhost`. Check `DOKPLOY_NETWORK` matches `docker network ls`, and that the host is the service's internal hostname. |
| `getaddrinfo ENOTFOUND <host>` | Wrong internal hostname, or the database service is in a different Dokploy project. |
| API restarts in a loop right after deploy | Databases still starting. Raise `WAIT_TIMEOUT`. |
| Migrations hang, then `Could not connect to the database while running migrations` | Medusa's pre-migration probe timed out. Raise `MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT` (ms, default 10000). See the note below — it can fire even when the database is reachable. |
| Build OOM-killed | Concurrent builds, or under 4 GB RAM. Set `COMPOSE_PARALLEL_LIMIT=1` and lower `BUILD_HEAP_MB`; on a small host build in CI and deploy by tag. |
| Uploaded images 404 (local provider) | `FILE_BACKEND_URL` must be `${API_PUBLIC_URL}/static`. |
| S3 uploads fail with `AccessDenied` on the ACL | set `S3_ACL=false` (BucketOwnerEnforced / R2). |
| S3 uploads fail with a DNS or signature error | non-AWS service needs `S3_ENDPOINT`, and usually `S3_FORCE_PATH_STYLE=true`. |
| Images still resolve to `/static` after setting S3 | `S3_BUCKET` empty or not reaching the container; check the api service env. |
| Seed data duplicated | `RUN_SEED` left `true`. Set false and redeploy. |
| `ERR_WORKER_OUT_OF_MEMORY` during build | `BUILD_HEAP_MB` too low for the dashboard build. Raise it — but never above host RAM. |
| **Dokploy panel itself goes down during a deploy** | Host OOM: the kernel killed Traefik or the panel instead of the build. Tell-tale signs are a host that still answers ping and still completes TCP handshakes on 80/443/3000 while returning zero bytes. Recover from the provider console (SSH is usually unreachable too), then set `COMPOSE_PARALLEL_LIMIT=1`, lower `BUILD_HEAP_MB`, and add swap. See §1a. |
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
| Overlays applied in every image build | 001 + 002 + 004 applied, 003 correctly skipped |
| S3 provider switch (overlay 004) against MinIO | upload → object in bucket → fetched back byte-identical; unsetting `S3_BUCKET` reverts to local |
| 404s in the **production** storefront image | unknown product / seller / collection → **404**; `/de`, existing product, existing seller → **200** |
| Dashboard SPA fallback on a deep route | 200, not 404 |
| `VITE_MERCUR_BACKEND_URL` baked into the bundle | found in `assets/*.js` |

## A note on the migration connection probe

Before migrating, Medusa races a `SELECT 1` against a timer
(`MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT`, default 10000 ms) and aborts with
"Could not connect to the database while running migrations … usually indicates
an incorrect database URL or an SSL configuration issue."

That message is a guess, not a diagnosis. While validating the split-services
topology locally (podman on macOS, containers on a user-defined bridge) it fired
**even though the database was fully reachable** — the same image had already
connected and created the `mikro_orm_migrations` table moments earlier, and
direct `pg` (8 ms), `knex` (11 ms), 80 concurrent connections (55 ms), 1 MB
result sets and Redis round-trips all succeeded on that same network. The
identical image and configuration migrated a fresh database successfully on host
networking in 20 s.

So if you hit it, **check reachability before believing the message**:

```bash
# from a shell in the API container
node -e "new (require('/app/node_modules/pg').Client)({connectionString:process.env.DATABASE_URL}).connect().then(()=>console.log('db ok'))"
```

If that succeeds, the probe is the problem, not your URL — raise
`MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT`. This was not reproduced on Docker under
Linux, which is what Dokploy runs.

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
