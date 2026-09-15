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
generated independently: `openssl rand -hex 32`. See "Special characters in
values" below for why hex rather than base64, and for the one place the
difference actually matters.

## Complete variable map

Audited 2026-09-16 by extracting every `process.env.*` from `apps/api`,
`packages/core`, `apps/storefront` and the overlays, then cross-checking against
every Dockerfile `ARG`, the CI build-args, all three compose files and these env
files. Kept in that state — if you add a variable, add it everywhere its column
says it belongs.

| Variable | Read by | When | Set in |
|---|---|---|---|
| `DATABASE_URL` | api entrypoint + medusa-config | runtime | api |
| `REDIS_URL` | api entrypoint + medusa-config | runtime | api |
| `JWT_SECRET` `COOKIE_SECRET` | medusa-config | runtime | api |
| `STORE_CORS` `ADMIN_CORS` `VENDOR_CORS` `AUTH_CORS` | medusa-config | runtime | api |
| `FILE_BACKEND_URL` | medusa-config (local file provider) | runtime | api |
| `S3_*` | overlay 004 | runtime | api |
| `MERCUR_VENDOR_URL` | `packages/core` seller module | runtime | api |
| `STOREFRONT_REVALIDATE_URL` `STOREFRONT_REVALIDATE_SECRET` | api revalidate subscriber | runtime | api |
| `ADMIN_EMAIL` `ADMIN_PASSWORD` `RUN_SEED` `WAIT_TIMEOUT` `PORT` | api entrypoint | runtime | api |
| `MEDUSA_DB_MIGRATION_CONNECTION_TIMEOUT` | Medusa framework | runtime | api |
| `MEDUSA_BACKEND_URL` | storefront server | runtime | storefront |
| `REVALIDATE_SECRET` | storefront revalidate route | runtime | storefront |
| `NEXT_PUBLIC_*` | storefront browser bundle | **build** | storefront |
| `VITE_MERCUR_BACKEND_URL` | dashboard bundle | **build** | admin, vendor |
| `BUILD_JOBS` | all four Dockerfiles | **build** | all four |
| `BUILD_HEAP_MB` | `Dockerfile.dashboard` only | **build** | admin, vendor |

Pairs that carry the same value under different names — getting these out of
step fails silently:

| This | must equal | this |
|---|---|---|
| api `STOREFRONT_REVALIDATE_SECRET` | = | storefront `REVALIDATE_SECRET` |
| api `STOREFRONT_REVALIDATE_URL` | = | the storefront's public domain |
| api `MERCUR_VENDOR_URL` | = | the vendor app's public domain |
| storefront `MEDUSA_BACKEND_URL`, dashboards `VITE_MERCUR_BACKEND_URL` | = | the api app's public domain |

## Special characters in values

Two different rules, and conflating them is how people either escape things that
never needed it or reuse a secret somewhere it breaks.

**Plain environment values** (`JWT_SECRET`, `COOKIE_SECRET`,
`STOREFRONT_REVALIDATE_SECRET`, …) accept effectively anything. Every layer
splits on the FIRST `=` and takes the remainder verbatim, so base64's `/`, `+`
and trailing `=` all survive untouched. Verified byte-for-byte through
`docker -e`, `--env-file`, and Compose `${VAR}` interpolation, with both `=` and
`==` padding. **An existing base64 secret needs no quoting, no escaping and no
regenerating.** The only character worth avoiding is `$`, which some parsers
interpolate.

**A password inside a URL** (`DATABASE_URL`, `REDIS_URL`) is the opposite: it is
parsed as a URL, so `/` and `#` make it invalid outright. Verified with the same
`new URL()` the entrypoint uses:

| Password contains | Result |
|---|---|
| alphanumeric only | OK |
| `@` | OK (the last `@` wins as the delimiter) |
| `:` | OK |
| `/` | **Invalid URL** |
| `#` | **Invalid URL** |
| a base64 secret | **Invalid URL** — base64 emits `/` |

That last row is the trap: reusing a base64 secret as a database password fails,
and it fails at the dependency-wait with a message that reads like a networking
problem.

**So: generate everything as hex and the distinction stops mattering.**

```bash
openssl rand -hex 32     # secrets  — 64 chars, 256-bit
openssl rand -hex 24     # db passwords — 48 chars, 192-bit
```

Hex is `[0-9a-f]` only: URL-safe, env-safe, shell-safe. If you are stuck with a
password you cannot change, percent-encode it instead:
`/`→`%2F`, `#`→`%23`, `?`→`%3F`, `@`→`%40`, `%`→`%25`.

## If NO variables reach the container

Seen in production on 2026-09-15. The API crash-looped and the entrypoint's
preflight listed the environment variable names the container could actually
see:

```
HOME HOSTNAME NODE_ENV NODE_VERSION PATH PWD YARN_VERSION
```

That is a bare `node:22-bookworm-slim` plus the `NODE_ENV` our own Dockerfile
sets — in other words **not one** user-supplied variable, including ones that
were definitely typed into the UI. When the list looks like that, the problem is
not a typo or a bad value; the Environment is not being injected at all, and no
amount of editing the values will help.

Check, in this order:

1. **Wrong field.** Runtime values must be in the Application's **Environment**
   tab. Anything put in a build-args field never reaches a running container.
2. **Wrong entity.** Confirm you are editing the application that is actually
   deployed, not a second application or a leftover Compose service in the same
   project.
3. **Project-scoped variables are not inherited.** Dokploy project/shared
   variables must be referenced explicitly from the app, e.g.
   `DATABASE_URL=${{project.DATABASE_URL}}`. Pasting them at project level does
   nothing on its own.

Confirm server-side what Dokploy actually wrote into the Swarm service:

```bash
docker service inspect $(docker service ls --format '{{.Name}}' | grep api) \
  --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'
```

`null` or a list without your variables proves Dokploy never wrote them. As a
stopgap you can inject them directly — a redeploy will overwrite this, so still
fix the tab:

```bash
docker service update \
  --env-add DATABASE_URL='postgres://USER:PASS@INTERNAL-HOST:5432/DB' \
  --env-add REDIS_URL='redis://INTERNAL-HOST:6379' \
  $(docker service ls --format '{{.Name}}' | grep api)
```
