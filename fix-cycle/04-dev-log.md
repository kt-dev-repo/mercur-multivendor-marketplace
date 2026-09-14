# 04 — Developer log (Stage 4 of 4)

Cycle 1. Input: `01-po-work-order.md`, `02-qc-gates.md` (binding), `03-test-report.md`.
Base `a4b87605c`, upstream base `a925daf62`, Medusa `2.20.1`.

All five items are implemented as overlays **005–009**, plus the S4 data-repair
script as a new file. **The tree is left pristine** — every overlay is `pending`,
and the merge-base invariant is empty (§ Part D).

One thing did **not** go as the gates predicted, and it matters: **gate S2-B's
"minimal repair" is wrong and, applied alone, is worse than the bug.** See S2
below and Part C-4.

---

## Part A — What shipped, per item

### S1 — overlay `005-store-line-item-no-client-price.patch`

**File:** `packages/core/src/api/store/carts/[id]/line-items/validators.ts` (one file, one hunk).

Deleted `unit_price` and `compare_at_unit_price` from `StoreAddCartLineItem`. The
schema is already `.strict()`, so both now fail as unrecognized keys with a clean
400, and the price resolves server-side from the offer inside `addToCartWorkflow`.

**Why this over the alternatives.** The gate (S1-C) forbids the obvious cheaper
move — keeping the field and adding `.positive()`. That would turn the `-100`
case into a 400 while leaving a client-supplied money field on a public route, so
`unit_price: 1` would still be honoured. Removal is the correct shape, not a
mitigation: Medusa's own store API never exposed these fields, the storefront
posts `{ offer_id, quantity }` only, and no existing spec sends them.

**S1-H (no cast to paper over the narrowed type).** `route.ts` is untouched.
`StoreAddCartLineItemType` narrows to `{ offer_id, quantity, metadata?,
additional_data? }`, `...item` narrows to `{ quantity }`, and `bun run build`
is green with **no** `as` anywhere. `packages/core/src/api/store/carts/middlewares.ts`
is untouched, so the `validateAndTransformBody(StoreAddCartLineItem)` pairing for
the exact matcher is intact (S1-G).

### S2 — overlay `006-cart-complete-idempotency.patch`

**Files (three, one concern):**
`packages/core/src/modules/seller/repositories/order-group.ts`,
`packages/core/src/workflows/cart/workflows/complete-cart-with-split-orders.ts`,
`packages/core/src/api/store/carts/[id]/complete/route.ts`.

**The gates' root cause was incomplete.** Gate S2-B says "the minimal repair is
`fields: ["id", "cart_id"]`". I implemented exactly that first, and it broke a
different, previously-green spec:

```
FAIL http/order/admin/order-list-filters.spec.ts
  ● Admin - Order Group store filter › returns only the selected seller's groups
    expect(received).not.toContain(expected)
    Expected value: not "og_01M24ZHW1MX0P3003H58E0FDSM"
    Received array:     ["og_01M24ZHW1MX0P3003H58E0FDSM"]
```

Two completions of two *different* carts returned the **same** order group.

`OrderGroupRepository.findAndCount`
(`packages/core/src/modules/seller/repositories/order-group.ts:63`) is a raw-SQL
override. It builds its `WHERE` clause by hand and recognises only `id`,
`customer_id`, `seller_id`, `status`, `sales_channel_id`, `created_at`,
`updated_at` and `q`. **A `cart_id` filter is silently dropped.** So the
workflow's `useQueryGraphStep({ entity: "order_group", filters: { cart_id } })`
was never scoped to the cart at all — it returned the whole table, and with
`options: { isList: false }` `data` is the first row of `ORDER BY og.created_at
DESC`, i.e. *the newest order group in the store*.

That is why the original `fields: ["cart_id"]` bug was survivable: `data.id` was
`undefined`, which accidentally masked a broken filter. Selecting `id` without
fixing the filter makes the guard fire against a stranger's order group and
**silently skips order creation for every cart after the first**. Silent
non-creation of orders is strictly worse than duplicate creation.

**What I shipped, therefore, is three layers:**

1. **Repository** — `cart_id` is now honoured, mirroring the existing
   `customer_id` clause. Eight added lines, no change to any other filter, no
   change to the SQL shape.
2. **Workflow** — `fields: ["id", "cart_id"]`, so `orderGroupId` resolves to a
   real id on re-entry and `when("create-order-group", …, ({ orderGroupId }) =>
   !orderGroupId)` is skipped. The guard stays a `when().then()`; `orderGroupId`
   stays produced by `transform`; no `if`/`for`/`await` added inside
   `createWorkflow` (S2-H). `acquireLockStep` stays first, `releaseLockStep`
   stays outside the branch, `idempotent: false` and `retentionTime` unchanged,
   no step lost a compensation (S2-I).
3. **Route** — reads `cart.completed_at` via `query.graph` before invoking the
   workflow and throws `MedusaError.Types.CONFLICT` → **409** when it is set. The
   check sits **before** the workflow call, so the
   `PAYMENT_AUTHORIZATION_ERROR` / `PAYMENT_REQUIRES_MORE_ERROR` → 200-with-cart
   branch is untouched (S2-G); `completed_at` is only ever written inside the
   create branch, so a payment failure leaves it unset and the customer can retry.

`updateCartsStep([updateCompletedAt])` was **not** moved out of the create branch.

**Semantics (as the brief fixed them):** route sees `completed_at` → 409; a racer
past the route hits the workflow guard → 200 with the pre-existing group.

### S3 — overlay `007-store-order-detail-customer-scope.patch`

**Files:** `packages/core/src/api/store/orders/middlewares.ts` (**new file, inside
the overlay**), `packages/core/src/api/store/middlewares.ts`,
`packages/core/src/api/store/orders/[id]/route.ts`.

**S3-B — mechanism choice, stated explicitly: option (i), and option (ii) is not
viable on its own.** The gate calls option (ii) (a handler-level
`if (!req.auth_context?.actor_id) throw UNAUTHORIZED`) "preferred". It cannot
work here. I verified in Medusa's compiled middleware table
(`@medusajs/medusa/dist/api/store/orders/middlewares.js`, and there is no
`allowUnauthenticated` authenticate anywhere on `/store/*`):

```
line 45  matcher "/store/orders"                       + authenticate("customer", ["session","bearer"])
line 53  matcher "/store/orders/:id"                     (NO authenticate)
line 60  matcher "/store/orders/:id/transfer/request"   + authenticate
line 69  matcher "/store/orders/:id/transfer/cancel"    + authenticate
line 77  matcher "/store/orders/:id/transfer/accept"      (NO authenticate — token-bearing)
line 85  matcher "/store/orders/:id/transfer/decline"     (NO authenticate — token-bearing)
```

Because no `authenticate` runs on `:id`, `req.auth_context` is undefined **even
when a valid customer JWT is presented**. Option (ii) alone would therefore 401
the legitimate customer as well as the attacker, failing S3-C and S3-D. Option
(i) is the only mechanism that can distinguish them.

So: a Mercur `store/orders/middlewares.ts` registers
`authenticate("customer", ["session", "bearer"])` for the matcher
**`/store/orders/:id` exactly**, wired into `storeMiddlewares` next to the
existing `storeOrderGroupsMiddlewares` (which is the precedent — the sibling
order-group routes already do exactly this). No wildcard, so
`transfer/accept` and `transfer/decline` keep their intentional token-based,
unauthenticated behaviour (**S3-G**). No `validateAndTransformQuery` is
re-registered — Medusa's own entry for the matcher still runs it, and a second
registration would transform `req.queryConfig` twice (**S3-H**).

The handler then adds `customer_id: req.auth_context.actor_id` alongside the
existing `is_draft_order: false` (**S3-F**), which
`getOrderDetailWorkflow`'s `useQueryGraphStep({ options: { throwIfKeyNotFound:
true } })` turns into a 404 for another customer's id (**S3-C**). The scope is
server-derived only; `?customer_id=` in the query string is still rejected 400 by
the strict validator (**S3-E**). `withCartPaymentCollectionFields` and
`normalizeOrderPaymentCollections` are unchanged (**S3-D**).

**G10 was required here.** The new file is imported by a patched upstream file,
so it had to be captured with `git add -N` before `git diff`. The patch contains
the `new file mode` hunk and `apply.sh --revert` deletes the file again:

```
$ grep -c "new file mode" deploy/overlays/007-store-order-detail-customer-scope.patch
1
```

### S4 — overlay `008-offer-inventory-seller-link.patch` + repair script

**Files:** `packages/core/src/workflows/offer/workflows/create-offers.ts`,
`packages/core/src/workflows/inventory-item/steps/link-seller-inventory-item.ts`,
`packages/core/src/workflows/inventory-item/workflows/create-seller-inventory-items.ts`.

The per-offer mapping is built in a **`transform`** over `offerSpans` — the
mapping the file already computes and already consumes at line 242 — and no
second mapping was invented (**S4-C3**):

```ts
const sellerInventoryItemLinks = transform(
  { input, inventoryItemsToCreate, createdInventoryItems },
  ({ input, inventoryItemsToCreate, createdInventoryItems }) =>
    input.offers.flatMap((offer, index) => {
      const span = inventoryItemsToCreate.offerSpans[index]
      return createdInventoryItems
        .slice(span.start, span.start + span.length)
        .map((item) => ({ seller_id: offer.seller_id, inventory_item_id: item.id }))
    }),
)
linkSellerInventoryItemStep({ links: sellerInventoryItemLinks })
```

No loop over the step, no reading `createdInventoryItems.<field>` outside a
`transform`, no `if`/`for`/`await` in the `createWorkflow` body.

**S4-C4/C5 — the shared step.** `linkSellerInventoryItemStep`'s input changed
from `{ seller_id, inventory_item_ids }` to `{ links: SellerInventoryItemPair[] }`,
because a compensation keyed to a single `seller_id` *cannot* express "dismiss
exactly what I created" for a mixed batch — that is the failure mode gate S4-C4
names. Both the invoke and the compensation now build their link definitions from
the same `toLinkDefinitions(pairs)` helper, so they are the same rows by
construction. The **second caller**,
`createSellerInventoryItemsWorkflow` (`create-seller-inventory-items.ts:30`), is
updated **in the same overlay** and keeps its single-seller behaviour, expressed
as a `transform` that stamps one `seller_id` across the created items.

**S4-C2 — the `?? ""` fallback is gone**, and its replacement is not silence: a
pair with a falsy `seller_id` now throws `INVALID_DATA` naming the item, and an
empty `links` array short-circuits without touching the link module.

**Data repair (S4-DATA) — `apps/api/src/scripts/repair-inventory-seller-links.ts`,
a new file, direct add.** Medusa `ExecArgs` CLI script. Verbs are bare words
(`apply`, `restore <path>`) rather than `--flags` because `medusa exec` parses
with yargs and rejects unknown options — `--apply` errors with
`Unknown argument: apply` before the script runs. Writes go through
`ContainerRegistrationKeys.LINK` (`dismiss` then `create`), never raw SQL
(**S4-D6**). Header comment states it is not a substitute for overlay `008`
(**S4-D7**). Full run evidence in Part B.

**S4-E4:** `validateSellerInventoryItem` and the vendor inventory-items routes
are **not** touched. The API check was always correct; it was operating on wrong
link data.

### S5 — overlay `009-vendor-product-ownership.patch`

**File:** `packages/core/src/api/vendor/products/middlewares.ts` only. Neither
`[id]/route.ts` nor `[id]/cancel/route.ts` needed a handler-level call, and
`helpers.ts` is unchanged — `ensureSellerOwnsProduct` is reused exactly as it is,
assigned-**or**-authored semantics intact (no second helper was written).

Two different middlewares, because the two questions are different:

- `ensureSellerOwnsProductParam` — calls `ensureSellerOwnsProduct(req.scope,
  req.seller_context!.seller_id, [req.params.id])`, which throws `NOT_FOUND` →
  **404**, never `FORBIDDEN`, and rejects the whole request rather than filtering
  it to empty (**S5-G**, **S5-L**: the seller id comes from `req.seller_context`
  only). Registered on `POST /vendor/products/:id`,
  `DELETE /vendor/products/:id` (whose `middlewares: []` becomes
  `[ensureSellerOwnsProductParam]`) and `POST /vendor/products/:id/cancel`.
- `ensureSellerCanViewProduct` — for `GET /vendor/products/:id`, per
  **[QC-AMENDS-PO] S5-D**. Ownership is the *wrong* question for the read:
  `applySellerProductLinkFilter` deliberately exposes the shared master catalogue
  so sellers can build offers against it, and applying `ensureSellerOwnsProduct`
  to GET would 404 the whole catalogue. So I extracted the list route's existing
  visibility predicate into `sellerVisibleProductPredicate` and both the list
  filter and the detail guard now use it. **They cannot drift**, which is what the
  gate actually asks for: a product absent from B's list 404s on B's detail read;
  a product present in B's list 200s. A's draft is neither B's nor `PUBLISHED`,
  so the reported leak is closed while offer creation still works.

**S5-K — validator pairing.** Ownership runs **after** validation in every list
(it needs only `req.params.id`), so `req.validatedBody` is still populated for
`POST /vendor/products/:id` (`VendorUpdateProduct`) and
`POST /vendor/products/:id/cancel` (`VendorCancelProductChange`).

**S5-H — the `policies: [...]` blocks are untouched**, all of them.

**S5-F — independence from `rbac`, stated as the gate demands.** No code path in
this fix consults `FeatureFlag` or `featureFlags`; the ownership middlewares are
unconditional entries in the `middlewares:` array. See Part C-8 for the awkward
part: the integration suite runs with `rbac: **true**`, not false, so the gate is
proven the *stronger* way round.

**S5-I — matcher coverage, stated not assumed.** Medusa matchers are path-exact.
Covered by this overlay:

| Matcher | Method | Guard |
|---|---|---|
| `/vendor/products/:id` | GET | `ensureSellerCanViewProduct` (list/detail consistency) |
| `/vendor/products/:id` | POST | `ensureSellerOwnsProductParam` |
| `/vendor/products/:id` | DELETE | `ensureSellerOwnsProductParam` |
| `/vendor/products/:id/cancel` | POST | `ensureSellerOwnsProductParam` |

**Not** covered, and their current state:

| Matcher | Method | State |
|---|---|---|
| `/vendor/products/:id/variants` | GET, POST | handler reads `req.seller_context!.seller_id` (`variants/route.ts:38`) — scoping exists but I did **not** verify it is an ownership assertion. **Cycle-2 item.** |
| `/vendor/products/:id/variants/:variant_id` | GET, POST | same, `variants/[variant_id]/route.ts:43,79`. **Cycle-2 item.** |
| `/vendor/products/:id/variants/:variant_id` | DELETE | `middlewares: []`, same shape as the DELETE hole this overlay closed. **Most likely remaining hole — cycle 2.** |
| `/vendor/products/:id/attributes/batch` | POST | handler reads `seller_context` (`attributes/batch/route.ts:15`). **Cycle-2 item.** |

I deliberately did **not** widen coverage to the sub-routes. The PO scoped S5 to
GET/POST/DELETE/cancel; a wildcard would also have pulled in S5-J and a real risk
of breaking legitimate variant work against shared-catalogue products, which is
scope creep in an item that is already the fifth of five. The DELETE-variant hole
is written down above rather than quietly fixed.

---

## Part B — Verbatim evidence

### Overlay status and the merge-base invariant (G1, G2, G4)

Pristine tree, all overlays reverted:

```
$ git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"
(empty)

$ ./deploy/overlays/apply.sh --check
  pending     001-storefront-not-found-status.patch
  pending     002-jest-swc-transform-resolution.patch
  pending     003-dashboard-ports-docs.patch
  pending     004-s3-file-provider-switch.patch
  pending     005-store-line-item-no-client-price.patch
  pending     006-cart-complete-idempotency.patch
  pending     007-store-order-detail-customer-scope.patch
  pending     008-offer-inventory-seller-link.patch
  pending     009-vendor-product-ownership.patch

$ git status --porcelain
 M LOCAL-SETUP.md
 M deploy/overlays/README.md
 M integration-tests/http/offer/store/cart-complete-idempotency.local.spec.ts
 M integration-tests/http/offer/vendor/offer-inventory-seller-link.local.spec.ts
 M integration-tests/http/product/vendor/product-ownership.local.spec.ts
?? apps/api/src/scripts/repair-inventory-seller-links.ts
?? deploy/overlays/005-store-line-item-no-client-price.patch
?? deploy/overlays/006-cart-complete-idempotency.patch
?? deploy/overlays/007-store-order-detail-customer-scope.patch
?? deploy/overlays/008-offer-inventory-seller-link.patch
?? deploy/overlays/009-vendor-product-ownership.patch
```

No upstream file is modified; the only modified files are ours
(`LOCAL-SETUP.md`, `deploy/overlays/README.md`) and the three `*.local.spec.ts`
files stage 3 added, which are also ours.

Applying all nine:

```
$ ./deploy/overlays/apply.sh
  applied     001-storefront-not-found-status.patch
  applied     002-jest-swc-transform-resolution.patch
  applied     003-dashboard-ports-docs.patch
  applied     004-s3-file-provider-switch.patch
  applied     005-store-line-item-no-client-price.patch
  applied     006-cart-complete-idempotency.patch
  applied     007-store-order-detail-customer-scope.patch
  applied     008-offer-inventory-seller-link.patch
  applied     009-vendor-product-ownership.patch
```

No `conflict`, no `skipped`. `--revert` returns all nine to `pending` (shown
above) and re-passes G1.

### G6 — no type escapes

```
$ grep -nE '^\+.*(\bany\b|@ts-ignore|@ts-expect-error)' deploy/overlays/00[5-9]*.patch
no hits
```

### `bun run lint` (overlays applied)

```
$ bun run lint
$ oxlint --quiet
```

Clean. **Note:** it was *not* clean when I started — stage 3's
`product-ownership.local.spec.ts` had an unused `publishedOfA`:

```
integration-tests/http/product/vendor/product-ownership.local.spec.ts:28:17: error eslint(no-unused-vars):
  Variable 'publishedOfA' is assigned a value but never used.
```

I fixed it by using the variable for its evident purpose — the *other* half of
gate S5-D (B must still read A's **published** catalogue product). That is a
direct edit to one of our own new spec files, not an overlay.

### `bun run build` (overlays applied)

```
$ bun run build
 Tasks:    12 successful, 12 total
Cached:    0 cached, 12 total
  Time:    41.997s
```

12/12. Not run against a live `next dev` (S0-A trap 3).

`apps/api` has **no** `build` task, so the repair script is not covered by that
run. Typechecked separately:

```
$ cd apps/api && bun x tsc --noEmit -p tsconfig.json | grep -i repair-inventory
(no output — zero errors in the new script)
```

(That run does report pre-existing errors in `seed-seller-order.ts`,
`probe-shared-priceset.ts` and `seed-reservations-sole-society.ts`. They predate
this cycle and are listed in Part E.)

### `bun run test:unit` (overlays applied)

```
$ bun run test:unit
Test Suites: 3 passed, 3 total
Tests:       13 passed, 13 total
```

13/13.

### G7 — the five reproductions, red then green

Both runs foreground, `--runInBand`, paths relative to `integration-tests/`, and
the **test count** is reported, not just the exit code (S0-A/S0-B).

Because the harness resolves `@mercurjs/core` through the package's `exports` to
`.medusa/server`, **`packages/core` must be rebuilt between the red and green
runs** or the run silently exercises the other tree's compiled output. Both runs
below were preceded by `cd packages/core && bun run build`. This is a fourth
false-green trap worth adding to `LOCAL-SETUP.md` next cycle.

**RED — overlays `005`–`009` reverted, core rebuilt pristine:**

```
$ TEST_TYPE=integration:http npx jest --runInBand --forceExit \
    http/offer/store/store-line-item-price-tampering.local.spec.ts \
    http/offer/store/cart-complete-idempotency.local.spec.ts \
    http/order/store/order-detail-pii-leak.local.spec.ts \
    http/offer/vendor/offer-inventory-seller-link.local.spec.ts \
    http/product/vendor/product-ownership.local.spec.ts

FAIL http/offer/vendor/offer-inventory-seller-link.local.spec.ts (8.627 s)
  ● S4-C1: each created inventory item links to the seller that declared it
  ● S4-C2: no link is ever created for an empty seller_id
FAIL http/offer/store/cart-complete-idempotency.local.spec.ts (22.479 s)
  ● S2-A: sequential complete #2 must not create a second order group
  ● S2-D: 5 concurrent completes on one fresh cart -> exactly 1 order group
  ● S2-K: two different carts still produce two different order groups
  ● S2-C/S2-J: invoking the workflow directly twice returns the pre-existing group
FAIL http/order/store/order-detail-pii-leak.local.spec.ts (14.7 s)
  ● S3-A: publishable key only (no customer JWT) must NOT return the order
  ● S3-C: customer B must get 404 on customer A's order
FAIL http/offer/store/store-line-item-price-tampering.local.spec.ts (10.271 s)
  ● S1-A: unit_price is rejected (400), not applied
  ● S1-B: compare_at_unit_price is rejected (400)
  ● S1-C: unit_price:-100 is a clean 400, not a 500
  ● S1-D: both fields at once are rejected (400)
FAIL http/product/vendor/product-ownership.local.spec.ts (10.424 s)
  ● S5-D: seller B must NOT read seller A's DRAFT (absent from B's list)
  ● S5-A: seller B -> POST /vendor/products/{A's id} is 404
  ● S5-B: seller B -> DELETE /vendor/products/{A's id} is 404

Test Suites: 5 failed, 5 total
Tests:       15 failed, 10 passed, 25 total
```

**GREEN — overlays `005`–`009` applied, core rebuilt:**

```
$ (same command)
Test Suites: 5 passed, 5 total
Tests:       25 passed, 25 total
```

25 tests executed both ways: 15 red → 0 red.

Two red results deserve a note:

- **S2-K is red on a pristine tree for a second reason.** The spec's own
  `orderGroupCount(cartId)` helper filters `order_group` by `cart_id`, and on a
  pristine tree that filter is dropped by the repository (see S2 above), so it
  counts every group in the database. That is the defect observing itself; both
  the count and the assertion go green with the overlay.
- **S4-C4 and S4-C5 pass on a pristine tree.** They are regression gates
  (compensation exactness, the shared second caller), not reproductions — the
  single-seller batches they exercise were correct "by accident" before. They are
  the gates that catch S4 shipping *broken*, which is exactly what S4-C4/C5 are
  for.

Tests I added inside the overlay work, because the gates assign them to the dev
and stage 3 flagged them as not tested: **S2-C/S2-J**, **S2-K**, **S4-C2**,
**S4-C4**, **S4-C5**, and the published-product half of **S5-D**. S2-D was
extended from "1 order group + no 5xx" to all six of the gate's conditions.

### G8 — the existing suite does not regress (overlays applied)

Run in five batches: a single `jest` process over the whole HTTP tree OOMs at
around 60 suites (`FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript
heap out of memory`), which is a harness limit, not a failure. `--max-old-space-size=8192`
plus batching is what worked.

```
http/offer http/order
  Test Suites: 3 skipped, 26 passed, 26 of 29 total
  Tests:       18 skipped, 134 passed, 152 total

http/product http/product-edit http/product-attribute http/product-categories http/product-tags http/product-types
  Test Suites: 16 passed, 16 total
  Tests:       4 skipped, 147 passed, 151 total

http/inventory http/reservation http/reservations http/rbac http/seller http/payment http/returns http/review
  Test Suites: 14 passed, 14 total
  Tests:       245 passed, 245 total

http/auth http/campaigns http/collections http/commission-rates http/currencies http/customer http/customer-group http/fulfillment-sets http/invite
  Test Suites: 13 passed, 13 total
  Tests:       148 passed, 148 total

http/payouts http/price-lists http/price-preferences http/promotions http/refund-reasons http/regions http/return-reasons http/sales-channels http/shipping-option-types http/shipping-options http/shipping-profiles http/stock-locations http/store-info
  Test Suites: 26 passed, 26 total
  Tests:       225 passed, 225 total
```

95 suites, **899 passed, 22 skipped, 0 failed**. Every surface the gates name is
covered: `http/offer` and `http/inventory` (S4-C7), `http/product`,
`http/product-edit`, `http/product-attribute` (S5-J), and `http/order` including
the `order-list-filters` spec that caught the S2 mis-fix.

### S4-DATA — the repair script, run for real against the live database

Live stack (`mercur-postgres`, `mercur-redis`), database `mercur`. The instance
confirms the S5-F premise on the way past:
`Using flag MEDUSA_FF_RBAC from project config with value **false**`.

**S4-D5 — dry run is the default, and writes nothing:**

```
$ bun --cwd apps/api run medusa exec ./src/scripts/repair-inventory-seller-links.ts
current inventory_item ↔ seller links: 1144 { sel_01M22BJF7PNMASHQVRVB1ED29A: 1144 }
offer-derived ownership: 1144 {
  sel_01M22BJEYXGEXVXMG6FGWNN1WD: 222,
  sel_01M22BJEMR7YT7Q2AN8WKR0BYE: 219,
  sel_01M22BJETEG1NEVZ41YQXX10F8: 240,
  sel_01M22BJF7PNMASHQVRVB1ED29A: 226,
  sel_01M22BJF3BQ4YD4572EVA6H3VQ: 237
}
rows to dismiss: 918
rows to create:  918
DRY RUN — nothing written. Re-run with `apply` to write.
```

**S4-D2 — ambiguity did not arise, and would have aborted.** The script computes
`ambiguous` (items resolving to 0 or >1 sellers) and `unresolvable` (linked items
with no offer) and throws `inventory→seller ownership is ambiguous` before any
write if either is non-empty. Both were empty here, which independently confirms
the PO's 1:1 claim over all 1144 rows.

**S4-D1 — apply, and the resulting distribution:**

```
$ ... repair-inventory-seller-links.ts apply
rows to dismiss: 918
rows to create:  918
snapshot written to .../apps/api/.medusa/repair-inventory-seller-links-1789023289162.json
to undo: medusa exec ./src/scripts/repair-inventory-seller-links.ts restore <that path> apply
repair complete: dismissed 918, created 918

$ ... repair-inventory-seller-links.ts        # re-read
current inventory_item ↔ seller links: 1144 {
  sel_01M22BJEYXGEXVXMG6FGWNN1WD: 222,
  sel_01M22BJF7PNMASHQVRVB1ED29A: 226,
  sel_01M22BJETEG1NEVZ41YQXX10F8: 240,
  sel_01M22BJEMR7YT7Q2AN8WKR0BYE: 219,
  sel_01M22BJF3BQ4YD4572EVA6H3VQ: 237
}
```

**240 / 237 / 226 / 222 / 219 = 1144** — the PO's target distribution exactly.

**S4-D3 — idempotent:**

```
$ ... repair-inventory-seller-links.ts apply     # second consecutive apply
rows to dismiss: 0
rows to create:  0
nothing to do — links already match offer-derived ownership
```

Zero changes, and no snapshot is written when there is nothing to do.

**S4-D4 — reversible, proven as a round trip.** Snapshot → repair → restore →
compare the pair set:

```
$ ... repair-inventory-seller-links.ts restore .../repair-inventory-seller-links-1789023289162.json apply
restoring 1144 pairs from ...
restore complete

$ ... repair-inventory-seller-links.ts            # re-read after restore
current inventory_item ↔ seller links: 1144 { sel_01M22BJF7PNMASHQVRVB1ED29A: 1144 }
```

Back to the exact pre-repair state. Re-applying then wrote a second snapshot;
the two snapshots' `(inventory_item_id, seller_id)` sets are byte-identical:

```
repair-inventory-seller-links-1789023289162.json  1144  sha256 03e289cc864727c549c62aa021401f5b3e99759b7388d32edcdd80bbfcfe6a6d
repair-inventory-seller-links-1789023330379.json  1144  sha256 03e289cc864727c549c62aa021401f5b3e99759b7388d32edcdd80bbfcfe6a6d
```

**The live database is left in the repaired state.**

### S4-EFFECT — the boundary actually holds, live

Item `iitem_01M22BJFZRTWCBQ8Z5RF095H11`, offer-owned by kickz
(`sel_01M22BJETEG1NEVZ41YQXX10F8`), previously link-owned by peakpace
(`sel_01M22BJF7PNMASHQVRVB1ED29A`). Vendor member logins, `x-seller-id` set:

```
B (kickz, the true owner)  GET  /vendor/inventory-items/{item}                 -> 200
A (peakpace, the rival)    GET  /vendor/inventory-items/{item}                 -> 404
A (peakpace, the rival)    POST /vendor/inventory-items/{item}/location-levels/batch -> 404
```

**S4-E1, S4-E2 and S4-E3 all hold.** Before the repair this was exactly inverted:
the owner got 404 on their own stock and the rival got 200 and could write it.

---

## Part C — the seven QC findings, answered

**1. S3 has no auth middleware to lean on; `req.auth_context` is undefined there.**
Confirmed at source, and it rules out the gate's *preferred* option. Because no
`authenticate` runs on `/store/orders/:id`, `req.auth_context` is undefined for a
legitimate customer too — option (ii) alone would 401 everyone and fail S3-C/S3-D.
I took **option (i)**, scoped to the `:id` matcher exactly. Details and the
verified Medusa middleware table are under S3 in Part A.

**2. S3 storefront risk — grep `apps/storefront` for order-detail fetches lacking a
customer token.** Done. There are exactly two call sites, both through one
function:

| Site | Call | Auth header |
|---|---|---|
| `app/[locale]/(main)/order/[id]/confirmed/page.tsx:16` | `retrieveOrder(params.id)` | yes |
| `app/[locale]/(main)/user/orders/[id]/return/page.tsx:15` | `retrieveOrder(id)` | yes |

`lib/data/orders.ts:33` `retrieveOrder` always sends
`headers: { ...(await getAuthHeaders()) }`. `app/[locale]/(main)/user/orders/[id]/page.tsx`
uses `retrieveOrderGroup`, which hits `/store/order-groups/:id` — already
authenticated today, unchanged by this cycle.

**The residual risk, stated plainly:** a **guest** (not logged in) landing on
`/order/{id}/confirmed` after checkout now gets 401 → `notFound()` instead of the
confirmation page. `getAuthHeaders()` returns nothing for a guest, so the token is
absent, not merely unused. This is the single most likely user-visible regression
in the cycle. It is also unavoidable given the item: there is no way to keep an
unauthenticated order read *and* close an unauthenticated PII leak on the same
route. Mitigations are a product decision for the PO, not mine — the two obvious
ones are a signed post-checkout token (which is how Medusa handles guest order
*transfer*) or redirecting guests to the order-transfer/claim flow. Note the
storefront's order **history** already requires login (`/store/order-groups/:id`
401s for guests today), so guest order access is already only partially supported.

**3. S5-D collides with the shared master catalogue; escalate rather than choose
differently.** No escalation needed — I implemented the gate's restatement
(list/detail consistency) rather than the PO's literal "GET → 404", and I did it
by *sharing the predicate* rather than duplicating it, so the list and the detail
read cannot diverge later. See S5 in Part A. Both halves are now tested: A's draft
404s for B, A's published catalogue product 200s for B and appears in B's list.

**4. S2-J: `validateCartPaymentsStep` runs before the guard; test it early.**
Tested with a run, not an argument. `S2-C/S2-J` in
`cart-complete-idempotency.local.spec.ts` invokes
`completeCartWithSplitOrdersWorkflow` at the container level **twice** on the same
cart; the second call resolves (it does not reject) and returns the **same**
`order_group_id` via the `createdOrderGroup?.id ?? orderGroupId` transform. So
`validateCartPaymentsStep` does **not** throw on re-entry — after completion the
sessions are `authorized`/`captured`, both of which are in the step's
`processablePaymentStatuses`. The 200-with-existing-group outcome is reachable and
the design did **not** have to change. **But** S2 half-landed for a different
reason entirely, which the gates did not anticipate: the `cart_id` filter the guard
depends on was being silently dropped by `OrderGroupRepository`. Gate S2-B's stated
minimal repair, applied alone, turns "duplicate orders" into "no orders at all for
every cart after the first" — a regression I caught only because
`http/order/admin/order-list-filters.spec.ts` exists. **QC should re-read gate S2-B:
its "minimal repair" is not sufficient and is actively unsafe.**

**5. S4-C4/C5: the link step is shared; changing the input shape without changing
both is the likeliest way S4 ships broken.** Both changed, in the same overlay.
The step now takes `{ links: SellerInventoryItemPair[] }`, invoke and compensation
build their payloads from one shared `toLinkDefinitions` helper, and
`createSellerInventoryItemsWorkflow` was updated with a `transform` that preserves
its single-seller behaviour. Covered by tests `S4-C4` (a failure after the link
step leaves the link-row count unchanged) and `S4-C5` (the other caller still
links both items to its one seller), plus `http/inventory` staying green.

**6. G10: an overlay that creates a file needs `git add -N`.** Relevant, and
handled — S3 took option (i), so `packages/core/src/api/store/orders/middlewares.ts`
is created inside overlay `007`. It was captured with `git add -N` first, the patch
contains a `new file mode` hunk (`grep -c` output in Part B), and
`apply.sh --revert` deletes the file again. One wrinkle worth recording for the
next dev: `git add -N` leaves an index entry behind, so after reverting, the file
shows as ` D` until `git rm --cached` clears it. The tree is not actually dirty,
but `git status` says it is.

**7. `?? ""` is a second latent bug; fix it in the same patch.** Done, in overlay
`008`. The fallback is gone and its replacement is loud: a falsy `seller_id`
throws `INVALID_DATA` naming the offending inventory item, rather than writing a
link to seller `""`. Tested by `S4-C2`, which also asserts no `seller_id === ''`
row exists anywhere after an empty batch.

**8. Not on QC's list, but it invalidates a gate as written: the integration suite
runs with `rbac: true`.** `integration-tests/medusa-config.ts:23` sets
`featureFlags: { rbac: true }` with a deliberate comment ("Enable it for the suite
so route policy declarations are actually exercised"). Gate S5-F's literal test —
stage 3 wrote `expect(FeatureFlag.isFeatureEnabled("rbac")).toBe(false)` and
reported it as PASSED — in fact **fails** in the harness, and did so on my red run.
It cannot pass without changing the whole suite's configuration, which is out of
scope and would weaken the other RBAC specs.

I rewrote S5-F to prove the gate's actual intent, the stronger way round:

- the fix's source is asserted to contain **no** `FeatureFlag` / `featureFlags`
  reference, and to still contain `policies:` (S5-H);
- the suite runs with policies **active** (`rbac: true`) and S5-A/B/D were
  **still red** on the pristine tree — which demonstrates directly that
  `policies: [...]` is not a tenant boundary *at any flag setting*, not merely
  when the flag is off;
- the rbac-**off** half is covered by the live instance, which logs
  `MEDUSA_FF_RBAC ... with value false` (see the repair-script run in Part B) and
  where stage 3 reproduced all of S5 against the identical middleware chain.

QC should decide whether that satisfies S5-F or whether a dedicated rbac-off
harness config is wanted in cycle 2. I did not silently weaken the gate; I am
flagging the substitution.

---

## Part D — Definition-of-done checklist

| Item | Overlay | `--check` | build | lint | red→green | invariant |
|---|---|---|---|---|---|---|
| S1 | `005` | pending | 12/12 | clean | 4 red → 5 green | empty |
| S2 | `006` | pending | 12/12 | clean | 4 red → 4 green | empty |
| S3 | `007` | pending | 12/12 | clean | 2 red → 4 green | empty |
| S4 | `008` + script | pending | 12/12 | clean | 2 red → 4 green | empty |
| S5 | `009` | pending | 12/12 | clean | 3 red → 8 green | empty |

Unit: 13/13. Regression: 899 passed / 22 skipped / 0 failed across 95 suites.

---

## Part E — Could not fix, and what blocked it

**Nothing in S1–S5 was left unfixed.** Two things I deliberately did not do, and
one I could not:

1. **`/vendor/products/:id` sub-route matchers (S5-I).** Not covered by overlay
   `009`; `DELETE /vendor/products/:id/variants/:variant_id` still has
   `middlewares: []`. Not blocked — **descoped on purpose**: the PO scoped S5 to
   GET/POST/DELETE/cancel and widening to a wildcard pulls in S5-J and a real risk
   to legitimate variant work on shared-catalogue products. Table in Part A.

2. **Gate S5-F's literal "rbac off" assertion.** *Blocked by the harness.* The
   integration suite deliberately sets `rbac: true`
   (`integration-tests/medusa-config.ts:23`); turning it off for one spec is not
   possible without changing the shared app config for every spec. Substituted a
   stronger proof — see Part C-8.

3. **Gate S2-B as literally written.** *Not implementable safely.* Its "minimal
   repair" (`fields: ["id", "cart_id"]` alone) causes silent order-creation
   failure. I implemented the guard the gate wants and added the repository fix
   it needs to be correct — a third file in overlay `006`. QC must accept the
   third file or the item cannot ship. Full explanation under S2 and Part C-4.

---

## Part F — Unrelated issues found, for the PO's next cycle

1. **`OrderGroupRepository.findAndCount` silently drops unknown filters.** Overlay
   `006` adds `cart_id`, but the wider defect stands: it is a hand-rolled `WHERE`
   builder that **ignores** any filter it does not explicitly recognise, so
   `query.graph({ entity: "order_group", filters: { … } })` returns the whole table
   for anything outside its eight-key allow-list. A dropped filter that returns
   *more* rows is a broken-access-control primitive, not a bug. It should either
   throw on an unknown key or be replaced with the standard repository. **Rank
   this high — it is the same class as P0.5.**

2. **`apps/api` has no `build` task**, so nothing under `apps/api/src` is
   typechecked by `bun run build`. Three scripts currently fail `tsc --noEmit`:
   `src/scripts/lib/seed-seller-order.ts:312`,
   `src/scripts/probe-shared-priceset.ts:175`, and
   `src/scripts/seed-reservations-sole-society.ts:60,72`. Cheap to fix, and adding
   a typecheck task would stop it recurring.

3. **A fourth false-green testing trap, for `LOCAL-SETUP.md`.** The HTTP harness
   resolves `@mercurjs/core` to `packages/core/.medusa/server`, not to `src/`. A
   red/green comparison that does not rebuild `packages/core` between runs
   silently exercises the previous tree's compiled output — I hit this exactly
   once and it produced a fully green "pristine" run. This belongs next to the
   three traps already in the troubleshooting table.

4. **`LOCAL-SETUP.md` contradicted its own trap.** Section 7 told the reader to run
   `bun run test:integration:http -- integration-tests/http/seller`, which is the
   zero-tests-exit-0 form its own troubleshooting table warns about. Fixed
   directly (ours, no overlay), with both forms shown side by side.

5. **Stage 3's `product-ownership.local.spec.ts` left `publishedOfA` unused**,
   which broke `bun run lint` for the whole repo on a pristine tree. Fixed by
   asserting the published half of S5-D. Worth a note that lint is not currently
   run as a gate on stage-3 output.

---

## Notes on state left behind

- **The tree is pristine.** All nine overlays are `pending`; the merge-base
  invariant is empty; nothing is committed.
- `packages/core/.medusa` is built from the **pristine** tree, so the live dev
  server on `:9000` is running unpatched (vulnerable) code again. Apply the
  overlays and rebuild `packages/core` before demoing the fixes.
- The **live database is repaired** (S4-DATA applied, 240/237/226/222/219). Two
  reversible snapshots are in `apps/api/.medusa/`.
- Not done, and not a gate: the `.claude/skills/mercur/SKILL.md` half of P5.2,
  which the PO offered as end-of-cycle slack.
