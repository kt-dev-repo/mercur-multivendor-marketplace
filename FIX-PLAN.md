# FIX-PLAN.md

Remediation plan from the static audit of **2026-09-10** against upstream base
`a925daf62` (v2.3.4-canary.6).

> **Cycle 1 closed 2026-09-14 — see `fix-cycle/CYCLE-1-CLOSURE.md`.**
> P0.1, P0.2, P0.4 and P0.5 are **fixed** (overlays `005`–`008`) and verified
> against the live stack. **P0.3 is only partially fixed** (overlay `009`) and
> remains exploitable through four sub-route matchers — it is the highest-priority
> carry-over. Their sections below are compacted to the outcome; the full original
> analysis is in git history at `21a6633d1`. Everything else here is untouched and
> still open.
>
> **Status of evidence**
> - Findings below marked **[VERIFIED]** were re-checked by hand against the
>   source, not accepted from a report.
> - The **runtime/exploit** results were still in flight when this was written;
>   §0 is the slot for them. Do not treat a static finding as exploitable until
>   §0 says so.

---

## Rule 0 — how every fix must be delivered

**No upstream-tracked file may be edited in a commit.** `main` is a byte-identical
mirror of upstream plus additive files. Every fix to upstream code ships as a new
patch in `deploy/overlays/`, applied on a copy at image-build time.

```bash
# 1. edit the upstream file in the working tree, verify it
# 2. capture it
git diff <file> > deploy/overlays/00N-short-name.patch
# 3. restore pristine
git checkout -- <file>
# 4. confirm
./deploy/overlays/apply.sh --check      # new patch reads "pending"
git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"   # must be empty
```

Overlay numbering continues from **005**. One concern per patch — a patch that
mixes two fixes cannot be retired independently when upstream fixes one of them.

**Definition of done for every item:** overlay exists → `apply.sh --check` clean →
`bun run build` 12/12 → `bun run lint` clean → a test that fails without the
overlay and passes with it → `git diff` against merge-base still empty.

---

## §0 Runtime results — COMPLETE (2026-09-10)

Live stack, 414 integration tests across 6 groups (**0 failures**), plus targeted
exploitation. **Every finding below is invisible to the existing test suites.**

### Static findings, re-tested at runtime

| ID | Static claim | Runtime verdict |
|----|--------------|-----------------|
| C1 | cross-tenant inventory write via flat batch route | **Not reachable as described** — but a worse variant is: see P0.4 |
| C2 | unscoped `delete` arrays | **Unproven** — seller link tables for those families are empty, no seller-B resources existed to attack |
| H1 | any vendor edits any collection | **Unproven** — same reason |
| H4 | seller visibility predicate | not exercised (no closed sellers seeded) |

So the static P1 items are **not** the top priority. The runtime pass found four
worse defects, two of them unauthenticated and directly monetary.

### What the suites prove, and what that says about them

171/171 vendor and 68/68 admin routes reject unauthenticated requests. All 21 store
routes enforce the publishable key. `x-seller-id` spoofing is blocked —
`ensureSellerMiddleware` verifies membership. Cross-tenant scoping is correct for
offers, orders, sellers, shipping-options and stock-locations (all 404). Line-item
input validation is solid: 14/15 malformed payloads returned clean 400/404,
including SQL-ish ids; no injection, no stack-trace leaks. 8 parallel line-item
adds produced exactly one item at qty 8 — the cart lock works.

**414 tests passed and none of the P0 defects below were caught.** The gap is not
coverage of the happy path; it is the absence of adversarial tests. Fixes must ship
with tests that would have caught these.

---

## Priority 0 — CONFIRMED EXPLOITS, unauthenticated and monetary

These displace everything below. Both P0.1 and P0.2 are reachable by anyone with
the publishable key, which is public by design.

### P0.1 — Customers set their own prices — **FIXED, overlay `005`**

`unit_price`/`compare_at_unit_price` removed from the public store line-item
validator; the schema is `.strict()` so both now 400. Live: 220 EUR stays 220 EUR.

### P0.2 — Cart completion is not idempotent — **FIXED, overlay `006`**

The guard queried `order_group` without selecting `id`, so it was always
undefined. Fixed in the workflow **and** in `OrderGroupRepository`, which
silently dropped the `cart_id` filter. Live: repeat complete 409, 5 concurrent
completes return one shared group.

### P0.3 — Vendor A modifies vendor B's product — **PARTIALLY FIXED, overlay `009`. STILL OPEN.**

GET/POST/DELETE/cancel on `/vendor/products/:id` now run an always-on ownership
middleware (404, never 403) that does **not** share RBAC's kill switch.

**Not covered — still exploitable:** `variants/route.ts:38`,
`variants/[variant_id]/route.ts:43,79`, `attributes/batch/route.ts:15` use
`seller_id` only as `created_by`. Reproduced live: seller B queued a
`VARIANT_ADD` change on seller A's product. Lands `pending` by default, but
`MEDUSA_FF_PRODUCT_REQUEST=false` makes `auto-confirm-product-change.ts:30`
confirm it immediately. **Carry into the next cycle.**

### P0.4 — All inventory items belong to one seller — **FIXED, overlay `008` + data repair**

`create-offers.ts` linked every item in a batch to `offers[0].seller_id ?? ""`;
now each item links to its own declaring seller and a falsy `seller_id` throws.
Live data repaired 1144 rows to 240/237/226/222/219, zero empty. Note
`link.dismiss` soft-deletes, so the raw table keeps 918 tombstones.

### P0.5 — Unauthenticated `GET /store/orders/:id` leaks PII — **FIXED, overlay `007`**

Medusa ships `/store/orders/:id` with no `authenticate`, so handler-level
checks 500 rather than 401. Fixed by registering `authenticate("customer")` on
that exact matcher and scoping the query to `req.auth_context.actor_id`. The
token-bearing `transfer/accept|decline` routes stay intentionally open. Live: 401.

### P0.6 — Unhandled 500s on trivial input, two reachable unauthenticated

| Request | Observed |
|---|---|
| `GET /store/products?limit=-1` | **500** (public) |
| `GET /store/products?order=%3Bnope` | **500** (public) |
| `POST line-items` `unit_price:-100` | **500** (public) |
| `GET /vendor/orders?created_at[$gt]=notadate` | **500** |
| `GET /vendor/offers?order=../../etc/passwd` | **500** |

No stack traces leak. `?limit=999999999` returns 200 **with no cap** — separate
resource-exhaustion concern.

---

## Priority 0b — Ours, not upstream

### P0b.1 — Running `bun run build` clobbered the dev server's `.next` **[FIXED]**

The storefront served `500 Internal Server Error` on every route for ~12 hours. A
production `next build` overwrote the running `next dev --turbopack` server's
`.next`. Resolved by `rm -rf apps/storefront/.next` and restarting — verified 200
with 4 product cards. **Never run `bun run build` against a live dev server**; add
this to `LOCAL-SETUP.md` troubleshooting.

### P0b.2 — Two testing traps that produce false green

- **Backgrounded `jest` exits 0 with no output within seconds.** Any CI or agent
  that detaches the test run reports success having run nothing. Always foreground.
- **`bun run test:integration:http -- <path>` needs a path relative to
  `integration-tests/`** (`http/offer`, not `integration-tests/http/offer`). The
  repo-relative form silently matches zero tests and **exits 0**.

Both belong in the tester agent's brief and in `LOCAL-SETUP.md`.

---

## Priority 1 — Cross-tenant writes (static; runtime status in §0)

> Re-ranked after the runtime pass: **P0 comes first**. P1.1 was not reachable as
> described, and P1.2/P1.3 remain unproven because the relevant seller link tables
> are empty. Keep them scheduled — an unproven finding on a 171-route surface is not
> a disproven one — but gate them behind a reproduction per Rule 0.

These are one omission repeated, not three bugs: **routes that take a resource id
from the request body instead of the path skipped the ownership check their
`:id`-scoped siblings perform.** Fix them together and add a guard so the class
cannot reappear.

### P1.1 — `POST /vendor/inventory-items/location-levels/batch` has no seller scoping **[VERIFIED]**

`packages/core/src/api/vendor/inventory-items/location-levels/batch/route.ts`
contains **zero** references to seller or ownership. `inventory_item_id` arrives
in the body (`../../validators.ts`) and is passed straight to
`batchInventoryItemLevelsWorkflow`.
`packages/core/src/api/vendor/inventory-items/middlewares.ts:138-152` registers
only `validateAndTransformBody` + `validateAndTransformQuery` and an
`inventory_item.create` policy — **no ownership middleware**.

The sibling `inventory-items/[id]/location-levels/batch/route.ts` proves intent:
it calls `validateSellerInventoryItem(req.scope, req.seller_context!.seller_id, id)`
**and** force-overwrites `inventory_item_id: id` on every create/update entry.

*Impact:* any authenticated vendor member can set, zero, or delete stock levels on
any other seller's inventory items. Cross-tenant write; trivially monetizable
(oversell or stock-out a competitor).

*Fix:* collect the distinct `inventory_item_id`s across `create`/`update` (and the
resolved parents of `delete`, see P1.2), assert every one belongs to
`req.seller_context!.seller_id` via the `inventory_item_seller` link, and reject
the whole request on any miss — fail closed, never filter silently.
**Preferred:** delete this route entirely and keep only the `:id`-scoped one; it
is redundant and strictly more dangerous.

### P1.2 — `delete` arrays are unscoped on every vendor batch route **[VERIFIED for inventory; re-verify each]**

The parent `:id` is validated; the **child ids in the body are not**. A vendor who
passes their own `:id` can delete another seller's children in the same call.

| Route | Unscoped field |
|---|---|
| `vendor/inventory-items/[id]/location-levels/batch` | `delete` (level ids) |
| `vendor/shipping-options/[id]/rules/batch` | `update`, `delete` (rule ids) |
| `vendor/promotions/[id]/rules/batch` | `update`, `delete` |
| `vendor/promotions/[id]/buy-rules/batch` | `update`, `delete` |
| `vendor/promotions/[id]/target-rules/batch` | `update`, `delete` |
| `vendor/price-lists/[id]/prices/batch` | `deletePriceIds` |

*Fix:* for each, re-query the child ids and assert `parent_id === req.params.id`
before the workflow runs. Extract one shared helper —
`assertChildrenBelongToParent(scope, entity, parentField, parentId, ids)` — rather
than six copies.

### P1.3 — `POST /vendor/collections/:id/products` lets any vendor relink the shared catalog **[VERIFIED]**

`packages/core/src/api/vendor/collections/[id]/products/route.ts` — **zero**
seller references; `add`/`remove` are arbitrary product ids.

*Impact:* products live in a **shared master catalog** (`product-seller-link`
allowlists which sellers may sell each product). Any vendor can add or remove any
product from any collection. Marketplace-wide merchandising corruption with no
attribution.

*Fix:* intersect `add`/`remove` with the caller's `product_seller` links, or move
the route to `admin/*` if vendors were never meant to have it.

### P1.4 — Add a regression guard for the whole class

A unit/integration test that walks every `vendor/*` route file and fails when a
handler reads an id from `req.validatedBody` without a corresponding ownership
assertion. Cheaper than re-auditing 171 vendor routes each release.

---

## Priority 2 — Money and settlement correctness

Silent, and only surfaces at reconciliation — worse than a crash.

### P2.1 — `upsertCommissionLines` is not transactional **[VERIFIED]**

`packages/core/src/modules/commission/service.ts:274` uses `@InjectManager()` while
the doc comment above it says "in a single transaction." The method deletes
existing lines by anchor, then upserts.

*Impact:* a failure between delete and upsert **permanently destroys** an order's
commission lines. Payout is computed as `order.total − Σ commission_line.amount`,
so the seller is overpaid by the full commission and the marketplace absorbs it.

*Fix:* `@InjectTransactionManager()`. One-line change, highest value-per-character
in this plan.

### P2.2 — Payout write steps have no compensation **[VERIFIED]**

`workflows/payout/steps/create-payout.ts`, `create-payout-account.ts`,
`create-onboarding.ts` each `return new StepResponse(x, x.id)` — the compensation
input is **built and then discarded**, because `createStep` is called with only
two arguments.

*Impact:* in `workflows/payout/workflows/create-payout.ts`, `createPayoutStep` runs
before `createRemoteLinkStep`. If the link fails, the payout row persists with no
seller link — money recorded as owed but invisible to `/vendor/payouts`, which
filters through that link. Re-running creates a **second** payout.

*Fix:* add the third argument to each:
```ts
async (id, { container }) => {
  if (!id) return
  await container.resolve<PayoutModuleService>(MercurModules.PAYOUT).deletePayouts(id)
}
```
Also add compensation to `commission/steps/upsert-commission-lines.ts` and
`seller/steps/{upsert-member,delete-seller-member,delete-member-invite}.ts`.

### P2.3 — Commission amounts downcast to JS float at persistence **[VERIFIED]**

`modules/commission/service.ts:146-147,157-158` —
`amount: MathBN.convert(amount).toNumber()`. Computation uses `MathBN` correctly,
then throws the precision away into a `model.bigNumber()` column.

*Impact:* rounding error per line, accumulating across a payout; worse for
3-decimal currencies and odd percentages.

*Fix:* return `BigNumberInput` and let the DML store it. Keep `.toNumber()` only
for the display-only `rate`. Note `service.ts` also carries **3 `@ts-ignore`** —
suppressed type errors in the money path; resolve them as part of this.

### P2.4 — "Most specific wins" is really "most dimensions wins" **[VERIFIED]**

`modules/commission/service.ts:130` scores specificity as
`new Set(rules.map(r => r.reference)).size`. A rate scoped to one `product` and one
scoped to one `seller` both score 1, so the tie breaks on `created_at ASC` — an old
store-wide rate beats a product-specific one.

*Fix:* decide the contract first. If dimension-count is intended, correct
`docs/ARCHITECTURE.md` and the `mercur` skill. Otherwise add a per-reference weight
(`product` > `product_category`/`product_collection` > `product_type` > `seller`)
as the primary sort key. **Do not "fix" this silently — it changes what sellers get paid.**

---

## Priority 3 — Availability and deploy safety

### P3.1 — Seller visibility predicate hides the wrong sellers **[VERIFIED — worse than first reported]**

`packages/core/src/api/utils/sellers.ts:16-19`:
```ts
$and: [
  { $or: [{ closed_from: null }, { closed_from: { $gt: now } }] },
  { $or: [{ closed_to: null },   { closed_to:   { $lt: now } }] },
]
```
Truth table:

| `closed_from` | `closed_to` | Meaning | Result | Correct? |
|---|---|---|---|---|
| null | null | never closed | visible | yes |
| yesterday | tomorrow | closed now | hidden | yes |
| last week | yesterday | closure over | **hidden** | **no** |
| tomorrow | next week | closure scheduled | **hidden** | **no** |

The last row is the one missed initially: a seller who merely *schedules* a future
closure disappears **immediately**. This gates the whole store catalog through
`api/store/offers/middlewares.ts`.

*Fix:* one OR expressing "not currently inside the window":
```ts
$or: [
  { closed_from: null },
  { closed_from: { $gt: now } },
  { closed_to:   { $lt: now } },
]
```

### P3.2 — Migrations run in every replica's entrypoint **[VERIFIED]**

`deploy/dokploy/entrypoint-api.sh` runs `db:migrate` unconditionally before
`exec medusa start`. Neither compose file sets `replicas`, but nothing prevents
scaling and Dokploy rolling deploys overlap old and new containers.

*Impact:* concurrent MikroORM migrations racing on one schema; link-table creation
is the likeliest casualty.

*Fix:* wrap in a Postgres advisory lock so only one container migrates:
```sh
psql "$DATABASE_URL" -c "SELECT pg_advisory_lock(8274531);" ...
```
or split migrations into a one-shot job. **This one is ours, not upstream** — it
lives in `deploy/`, so it is a direct edit, not an overlay.

### P3.3 — `scanUnauthenticatedRoutes` can disable auth on a route that never asked **[VERIFIED]**

`api/utils/scan-unauthenticated-routes.ts:38` — the second branch matches **any**
re-export block containing the token:
```ts
/export\s*\{[^}]*\bAUTHENTICATE\b[^}]*\}/.test(content)
```
`export { AUTHENTICATE }` where the value is `true` makes the route public. It is a
regex over source text, so the token in a comment or a string also counts. Matched
routes skip **both** `authenticate` and `ensureSellerMiddleware`.

*Fix:* require `=\s*false` in the re-export branch too, or resolve the actual
exported value instead of pattern-matching source.

---

## Priority 4 — Hardening and hygiene (ours, direct edits)

| ID | Item | Location |
|---|---|---|
| P4.1 | Healthcheck hardcodes `:9000`, ignores `PORT` — container reports unhealthy forever if `PORT` changes | `deploy/dokploy/Dockerfile.api` |
| P4.2 | `medusa build \|\| true` asserts only `medusa-config.js`; a build that drops routes/workflows still ships | `deploy/dokploy/Dockerfile.api` |
| P4.3 | Runtime `bun install --production` with no lockfile — image not reproducible | `deploy/dokploy/Dockerfile.api` |
| P4.4 | `DATABASE_URL` assembled without URL-encoding the password; `@ : / # ?` break both libpq and the entrypoint's `new URL()` | `docker-compose.dokploy-bundled.yml`, `.env.example` |
| P4.5 | All three images run as **root** — add `USER node` | all `deploy/dokploy/Dockerfile.*` |
| P4.6 | `REVALIDATE_SECRET` passed as a **build arg**; only needed at runtime, and build args surface in logs/UI | `docker-compose.dokploy.yml`, `Dockerfile.storefront` |
| P4.7 | `S3_ADDITIONAL_CLIENT_CONFIG` `JSON.parse`d unguarded — malformed value crashes boot with a bare `SyntaxError` | overlay `004` |
| P4.8 | `medusa user ... \|\| echo` swallows every failure, not just duplicate-user | `entrypoint-api.sh` |
| P4.9 | No security headers on the dashboard SPA (holds an admin session) | `deploy/dokploy/nginx-spa.conf` |

---

## Priority 5 — Type safety and documentation truth

### P5.1 — 162 `any` in `packages/core/src` **[VERIFIED: 162, excl. `.d.ts` and tests]**

Against an explicit "NEVER use `any`" rule in `CLAUDE.md`. Worst offenders:

| Count | File |
|---|---|
| 24 | `modules/product-attribute/service.ts` |
| 15 | `modules/seller/service.ts` |
| 10 | `modules/custom-fields/services/custom-fields-module-service.ts` |
| 10 | `api/vendor/promotions/[id]/[rule_type]/route.ts` |
| 10 | `api/admin/promotions/[id]/[rule_type]/route.ts` |
| 7 | `modules/seller/repositories/order-group.ts` |

Root pattern is the service-override signature
`<T extends any | any[]>(data: any): Promise<T extends any[] ? any[] : any>` —
`any | any[]` collapses to `any`, so the conditional return type is decorative.
Fixing that one generic removes a large share of the count.

*This is a large, low-urgency refactor of upstream code. As an overlay it would be
a maintenance burden with a high conflict rate. Recommend: do not overlay. Track
it, and fix opportunistically only in files an overlay already touches.*

### P5.2 — Docs describe scheduled jobs that do not exist **[VERIFIED]**

`docs/ARCHITECTURE.md:64,127` and `.claude/skills/mercur/SKILL.md:45` both assert a
payout capture-check job every 15 min and a daily 1 AM UTC payout job. There is
**no `jobs/` directory and no `schedule:` anywhere in `packages/core`** — payouts
are reachable only via the webhook subscriber.

**The skill error is ours** — the claim was copied from upstream's docs without
verification, and now misleads every future session. Correcting
`.claude/skills/mercur/SKILL.md` is a **direct edit** and should be done first, it
costs nothing. The upstream doc fix is overlay `003`'s territory.

### P5.3 — Lower-severity items

- Commission `code` uses `Math.random().toString(36).slice(2,8)` against a
  `.unique()` column — intermittent 500s at scale. Use `crypto.randomUUID()`.
- `/hooks/payout` enqueues every unauthenticated POST to the Redis event bus
  (`attempts: 3, delay: 5000`) **before** signature verification, which happens
  later in the provider. Rate-limit, or verify in the route.
- `created_by` means *member id* in `offer` and *seller id* in `product-edit`, and
  is exposed as a client-supplied filter in `vendor/reservations/validators.ts`.

---

## Suggested execution order (revised after the runtime pass)

1. **P0.1** — two-line validator change, stops unauthenticated price tampering.
2. **P0.2** — route `completed_at` check **and** the workflow re-entry guard.
3. **P0.5** — add the `actor_id` filter; one route, copies its siblings.
4. **P0.3** — ownership assertion on `vendor/products/:id` writes, independent of
   the `rbac` flag.
5. **P0.4** — triage the provisioning path first; fix the data, then add a
   constraint/test so the link cannot skew again.
6. **P0.6** — input coercion on the public query params.
7. **P0b.1 / P0b.2** — ours, documentation, free.
8. **P5.2 skill correction** — free.
9. **P2.1** (`@InjectTransactionManager`), **P2.2** (payout compensation) — small,
   high financial exposure.
10. **P1.\*** — only behind a reproduction; otherwise they are speculative.
11. **P3.\***, **P4.\*** — hardening.
12. **P2.3 / P2.4** — need the PO's product decision.
13. **P5.1** — track, do not overlay.

### Upstream disclosure

P0.1, P0.2, P0.3 and P0.5 are **security defects in upstream Mercur**, not in our
additions. Report them privately to mercurjs before any public write-up. Our
overlays are stop-gaps, not the fix of record.

## Explicitly out of scope

- Rewriting upstream to remove `any` wholesale (P5.1).
- Changing commission semantics (P2.4) without a decision from the PO role.
- Any fix that requires editing an upstream file **in a commit** — Rule 0 stands.
