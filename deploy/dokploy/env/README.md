# Per-application environment files

These are for the **four separate Dokploy Applications** topology described in
[`../DEPLOY-SEPARATE-APPS.md`](../DEPLOY-SEPARATE-APPS.md). Each Dokploy
Application has its own Environment tab, so there is one file per app.

| Paste into | File | Dockerfile | Build Stage | Port |
|---|---|---|---|---|
| `mercur-api` | [`api.env.example`](api.env.example) | `Dockerfile.api` | — | 9000 |
| `mercur-storefront` | [`storefront.env.example`](storefront.env.example) | `Dockerfile.storefront` | — | 3000 |
| `mercur-admin` | [`admin.env.example`](admin.env.example) | `Dockerfile.dashboard` | `admin` | 80 |
| `mercur-vendor` | [`vendor.env.example`](vendor.env.example) | `Dockerfile.dashboard` | `vendor` | 80 |

**Build Stage is required for the two dashboards.** They share one Dockerfile and
differ only by that field. A Dockerfile with no target builds its last stage, so
an empty field would silently give you the *vendor* dashboard — on the admin
domain included. The Dockerfile now ends in a guard stage that fails the build in
about a second instead, with a message telling you to pick one.

Deploy order is **api → storefront → admin → vendor**, one at a time. The other
three bake the API URL into their bundles, and the storefront's publishable key
does not exist until the API has seeded.

## Which file do I want?

| Topology | Env |
|---|---|
| Four separate Applications, built on the server | **these files** |
| One Compose stack (`docker-compose.dokploy*.yml`) | [`../.env.example`](../.env.example) |
| Images built in CI, server only pulls | [`../.env.example`](../.env.example) + `IMAGE_REPO`/`IMAGE_TAG`; the build-time values move to GitHub repository *variables* |

Do not paste `../.env.example` into a single Application — it is one blob mixing
values from all four, and the build-time entries belong to whichever app bakes
them.

## Build-time vs runtime

The distinction decides whether a change needs a restart or a rebuild, and
getting it wrong fails silently.

| App | Build-time | Runtime |
|---|---|---|
| api | `BUILD_JOBS` | everything else |
| storefront | every `NEXT_PUBLIC_*`, `BUILD_JOBS` | `MEDUSA_BACKEND_URL`, `REVALIDATE_SECRET` |
| admin / vendor | **all three values** | — (nginx serving static files) |

A Vite SPA is static files; there is no process to read an environment variable
at runtime. `NEXT_PUBLIC_*` is compiled into the browser bundle by Next. In both
cases editing the Environment tab and pressing **Restart** does nothing — use
**Redeploy (rebuild)**.

`BUILD_HEAP_MB` exists **only** for the two dashboards. `Dockerfile.api` and
`Dockerfile.storefront` declare no such build arg; setting it there has no
effect.

## Values that must match across apps

| Value | Must equal |
|---|---|
| storefront `REVALIDATE_SECRET` | api `STOREFRONT_REVALIDATE_SECRET` |
| storefront `MEDUSA_BACKEND_URL`, dashboards `VITE_MERCUR_BACKEND_URL` | the api app's public domain |
| api `STORE_CORS` / `ADMIN_CORS` / `VENDOR_CORS` / `AUTH_CORS` | the exact public origins of the other three |
| storefront `NEXT_PUBLIC_DEFAULT_REGION` | a region the seed created (default `de`) |

Secrets (`JWT_SECRET`, `COOKIE_SECRET`, `STOREFRONT_REVALIDATE_SECRET`) should be
generated independently: `openssl rand -base64 32`.
