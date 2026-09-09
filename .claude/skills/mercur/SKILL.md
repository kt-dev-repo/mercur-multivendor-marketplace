---
name: mercur
description: Navigate the Mercur marketplace monorepo — domain model, package map, seller scoping, and local run commands. Use when working anywhere in this repo and you need to know where code lives or how marketplace concepts fit together.
---

# Mercur Marketplace Platform

Use this skill when:
- you need to locate the right package or app for a change
- the task touches marketplace domain concepts: seller, member, offer, order-group, commission, payout, product change
- you are wiring the dashboards (`packages/admin`, `packages/vendor`) or the storefront
- you need to start the stack locally or are debugging a run/port/env problem

Mercur adds a **marketplace layer** on top of Medusa. For framework-level mechanics (modules, workflows, links, migrations, tests), load the `medusa` skill. This skill is about *what* the domain is and *where* things live.

## Package Map — where to make a change

| You are changing | Go to |
|---|---|
| Marketplace business logic, DB models, API routes | `packages/core` |
| Shared TypeScript types | `packages/types` |
| Typed HTTP client used by dashboards | `packages/client` |
| Operator dashboard pages (~39) | `packages/admin` |
| Seller dashboard pages (~24) | `packages/vendor` |
| Shared dashboard React primitives | `packages/dashboard-shared` |
| Dashboard routing / block resolution (Vite plugin) | `packages/dashboard-sdk` |
| `mercurjs` CLI commands | `packages/cli` |
| Block catalogue | `packages/registry` |
| Stripe Connect payouts | `packages/providers/payout-stripe-connect` |
| Customer-facing Next.js storefront | `apps/storefront` |
| Medusa server wiring / config | `apps/api` |
| Scaffolds produced by `create-mercur-app` | `templates/basic`, `templates/plugin` |

**Apps are starters that consume packages.** A dashboard feature belongs in `packages/admin` or `packages/vendor`, not in `apps/admin-test` or `apps/vendor` — the apps only mount the packages and configure Vite.

## Domain Model — the parts that surprise people

- **Seller** — the vendor entity. Status `pending_approval` / `open` / `suspended` / `terminated`. Operator-only `is_premium`. Optional scheduled closure via `closed_from` / `closed_to`.
- **Member** — a user belonging to a seller, with roles. **Many-to-many**: one user can belong to several sellers and switch between them. Every seller needs at least one admin member.
- **Master Product** — products live in a **single shared catalog and are not owned by any seller**. A `product-seller-link` allowlists which sellers may sell a product. Status `draft` / `proposed` / `published` / `rejected`.
- **Offer** — the real center of seller commerce, not the product. A seller's listing against a master product/variant, carrying that seller's SKU, offer-scoped price (through a pricing rule), offer-scoped inventory item, and shipping profile. **Cart and order line items link to the offer**, not directly to the seller.
- **Product Change** — every product edit is captured as an immutable record in the `product-edit` pipeline, as typed actions (`UPDATE`, `VARIANT_*`, `ATTRIBUTE_*`, `STATUS_CHANGE`, `PRODUCT_ADD/DELETE`). Status `pending` → `confirmed` / `declined` / `canceled` / `requires_action`. Low-risk edits auto-confirm. A vendor product write usually creates a change request rather than mutating the product.
- **Order-Group** — lets one customer cart hold items from multiple sellers. On placement the cart **splits into one order per seller**, each linked to a parent group. Has serial `display_id`, read-only `cart_id`, query-time computed `seller_count` / `total`. Never assume one cart equals one order.
- **Commission** — deducted from payouts at order placement. Rules match on `product` / `product_type` / `product_collection` / `product_category` / `seller`; **most-specific wins** (AND across dimensions, OR within one), ties broken by oldest rule. Fixed rates support per-currency amounts. **Only the global rate may include shipping.** Arithmetic uses BigNumber — never plain JS floats on money.
- **Payout** — settlement to a seller's connected account, default provider Stripe Connect. Account lifecycle `PENDING` → `ACTIVE` ↔ `RESTRICTED` / → `REJECTED`, driven by provider webhooks. A daily job (1 AM UTC) emits `payout.requested`; a subscriber runs `createPayoutWorkflow`. Capture-check job runs every 15 min.
- **Product Attributes** — operator-managed typed catalog (`multi_select`, `single_select`, `text`, `unit`, `toggle`). A `multi_select` attribute flagged `is_variant_axis` maps to a native Medusa `ProductOption` and generates variants. `is_filterable` exposes it as a storefront filter.
- **Blocks** — feature packages distributed as **source code, not npm packages**. `mercurjs add` copies files into the project so you own them; `mercurjs diff` + `--overwrite` pulls updates. Declared in `blocks.json`.

## The Three API Surfaces

`packages/core/src/api/` splits into `admin/`, `vendor/`, and `store/`. This split is a **security boundary**:

- `admin/*` — marketplace operator. Full cross-seller visibility.
- `vendor/*` — seller-scoped. **Must** derive the seller from `req.auth_context.actor_id`. A `vendor/*` route that reads `seller_id` from the body or query is a cross-tenant data leak.
- `store/*` — customer-facing, unauthenticated or customer-authenticated.

`withMercur()` in `apps/api/medusa-config.ts` mounts core and auto-registers the roles module that makes vendor scoping work.

## Request Flow (worth internalising)

```
Vendor UI (packages/vendor page)
  -> sdk.vendor.products.mutate(payload)          @mercurjs/client typed proxy
    -> POST /vendor/products                      apps/api
      -> vendor route + middleware (scopes to seller)   packages/core
        -> workflow: product enters `proposed`,
           ProductChange record captures the edit
          -> Medusa product service -> Postgres
            -> core query config normalises response
              -> TanStack Query refetches in the dashboard
```

`@mercurjs/client` is a recursive Proxy: `sdk.admin.products.$id.query({ $id })` is `GET /admin/products/:id`, `.mutate()` is POST, `.delete()` is DELETE. Types come from the generated route map (`mercurjs codegen`). It is the **only** HTTP layer the dashboards use — do not hand-write `fetch` in a dashboard page.

## Running Locally

```bash
bun install                 # root, resolves all workspaces
bun run build               # turbo; packages build before apps
bun run lint                # oxlint
```

Data stores must be up first (Postgres 13+ and Redis). They run as two
independent services, one compose file each:

```bash
docker compose -f docker-compose.postgres.yml up -d
docker compose -f docker-compose.redis.yml    up -d
```

Either can be restarted or wiped alone. To use externally hosted instances
instead, skip both and point `DATABASE_URL` / `REDIS_URL` in `apps/api/.env` at
them — nothing else in the repo references the compose files.

Then:

There is no `bunx` in this toolchain — use `bun x`.

```bash
cd apps/api && bun x medusa db:migrate && bun run seed && bun run dev   # :9000
cd apps/storefront && bun run dev                                       # :3000
cd apps/admin-test && bun run dev                                       # :7001  (see gotcha)
cd apps/vendor     && bun run dev                                       # :7002  (see gotcha)
```

## Gotchas — verified against this tree

1. **The documented dashboard ports are wrong.** `CLAUDE.md` and `docs/ARCHITECTURE.md` say admin `:7000` and vendor `:7001`. The actual `dev` scripts bind **admin `:7001`** and **vendor `:7002`** (`:7000` and `:7001` are the *preview* ports). Trust `package.json`. Any `*_CORS` env value must cover the ports you actually run.
2. **`scripts/dev.sh` is not portable.** It hardcodes `REPO_ROOT="/Users/viktorholik/Desktop/mercur"` and does not start the storefront. Start apps directly instead of using it.
3. **The storefront is not in the scaffold.** `bun create mercur-app` produces `templates/basic`, which has API + admin + vendor but **no storefront**. `apps/storefront` exists only in this monorepo.
4. **Store line items take `offer_id`, never `variant_id`.** `POST /store/carts/:id/line-items` with `variant_id` fails: `Field 'offer_id' is required; Unrecognized fields: 'variant_id'`. The offer is the sellable unit — get it from `product.variants[].offer_id` on the store product response. This is the single biggest difference from stock Medusa.

5. **`bun run seed` does create a publishable API key.** It seeds the sales channel, a `Default Publishable API Key`, categories, global product attributes, 5 sellers, 50 products, and ~1144 offers. Read the token from `api_key` where `type='publishable'` and put it in `apps/storefront/.env.local`.

6. **`bun run test:unit` fails out of the box under bun.** The script runs `jest --rootDir ..`, so Jest resolves `@swc/jest` from the repo root, but bun installs it only into `integration-tests/node_modules` and `apps/api/node_modules` — nothing hoists it. Symlink it into root `node_modules/@swc/` (a generated dir, no tracked file changes) and the suite runs.

7. **Integration tests need a `postgres` superuser.** `integration-tests/.env.test` hardcodes `postgres:postgres@localhost:5432` and `@medusajs/test-utils` builds its connection from the `DB_*` vars, not `DATABASE_URL`. The runner creates and drops databases, so that role needs `SUPERUSER CREATEDB`. Add the role to your server rather than editing the tracked `.env.test`.
8. **Storefront default region is `de`.** `.env.template` sets `NEXT_PUBLIC_DEFAULT_REGION=de`, which matches the seed. Changing one without the other yields an empty storefront.
9. **`STORE_CORS` in `templates/basic/packages/api/.env.template` lists `:8000`, not `:3000`.** The storefront runs on `:3000`, so the template value alone blocks it.
10. **Two zod majors coexist.** Root pins `zod@3.25.76` (backend/validators); several dashboard packages declare `zod@4.4.3`. Match the workspace you are editing.
11. **Medusa is pinned to 2.20.1 by root `overrides`.** Do not bump it in a single workspace.
12. **The storefront soft-404s.** Unknown product, seller and collection handles return HTTP **200**, not 404 — `ProductDetailsPage.tsx` does `if (!prod) return null` and the seller/collection pages return `{}` / render `<NotFound />` without a status. Only `categories/[category]/page.tsx` calls `notFound()`. Search engines will index empty pages.
13. **`medusa build` crashes under the bun runtime on Linux.** MikroORM reads decorator positions off stack traces via source-map-support and throws ``` `column` must be greater than or equal to 0 ```. Install with bun; run medusa (and next/vite in images) with Node.
14. **Workspace binaries are not hoisted.** Under bun's isolated layout `medusa` and `vite` live in each workspace's own `node_modules/.bin`, not the repo root.
15. **Store `shipping-options` are keyed by seller.** `GET /store/shipping-options?cart_id=…` returns an object mapping `seller_id -> options[]`, not a flat array. A multi-seller cart needs one shipping method added **per seller** before it can complete.

## Repo Working Rules (from CLAUDE.md — these are enforced)

- `bun` only. Never npm/yarn/pnpm.
- Never `any`.
- No AI-narrating comments; code must read as human-authored.
- Never run bare `bun run test:integration:http` — always pass a pattern.
- Bug fixes and features **must** include tests; for a reproducible bug, write the failing test first.
- `bun run build` must pass before finishing.
- **Do not commit unless explicitly asked.**
- Conventional Commits (`feat(scope):`, `fix(scope):`); branches `<type>/<feature>`.
- Never name a branch or worktree after a coding agent, and never mention AI assistants in commits, PR titles, or PR bodies — no `Co-Authored-By`, no footers, no 🤖.

## Output Format

When asked where something lives, answer with the concrete path and the layer it sits in. When implementing, state which surface (`admin` / `vendor` / `store`) the change targets and how seller scoping is enforced before writing code.
