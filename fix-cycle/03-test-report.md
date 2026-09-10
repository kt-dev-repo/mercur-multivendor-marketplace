# 03 — Tester report (Stage 3 of 4)

Cycle 1, **pass 1: failing reproductions before any fix exists.** No overlay 005–009
is applied; the tree is pristine (`git diff --diff-filter=MDR` vs merge-base → empty,
verified below). Every scheduled item is expected to FAIL now and does.

Environment: live stack up (`mercur-postgres`, `mercur-redis` healthy, API on
`:9000`). Publishable key
`pk_79b03ffd365a959b0e8a25eda692a8d05e6e5b0cc52f94845f8ab7d29dbd3a3a`. Region
`reg_01M22BJEEFS0RBZHQ1PMSBHF0P` (Europe, eur).

Brief traps observed (S0-A / S0-B): all jest runs below are **foreground**, paths are
**relative to `integration-tests/`** (`http/…`, never `integration-tests/http/…`), and
I report the **number of tests executed** per spec, not just the exit code. No
`bun run build` was run against the live `next dev`.

---

## Summary table

| Item | Repro command | Expected (post-fix) | Observed (pristine) | Verdict |
|---|---|---|---|---|
| **S1 / P0.1** price tampering | live curl + `bun run test:integration:http -- http/offer/store/store-line-item-price-tampering.local.spec.ts` | `unit_price`/`compare_at_unit_price` → 400; `unit_price:-100` → 400 | qty5@44 normal = **220**; `unit_price:1` → **200, total 5**; `unit_price:-100` → **500**; harness **4 failed / 1 passed, 5 run** | **CONFIRMED** |
| **S2 / P0.2** duplicate orders | live curl (seq + race) + `... -- http/offer/store/cart-complete-idempotency.local.spec.ts` | seq #2 → 409; 5-race → exactly 1 order_group | seq #2 → **200, 2nd order_group**; true 5-race → **5 groups / 10 orders / 1 payment**; harness **2 failed, 2 run** | **CONFIRMED** |
| **S3 / P0.5** order PII leak | live curl + `... -- http/order/store/order-detail-pii-leak.local.spec.ts` | pub-key only → 401/404; other customer → 404 | pub-key only → **200 + email/name/address/total**; other customer → **200**; harness **2 failed / 2 passed, 4 run** | **CONFIRMED** |
| **S4 / P0.4** inventory→seller link | live DB + `... -- http/offer/vendor/offer-inventory-seller-link.local.spec.ts` | each item → its own offer's seller | 2-seller batch: B's item linked to **A**; live skew **1144 all on one seller**; B 404 on own item, A 200+tamper on rival; harness **1 failed, 1 run** | **CONFIRMED** |
| **S5 / P0.3** vendor product routes | live curl + `... -- http/product/vendor/product-ownership.local.spec.ts` | B→A's product: GET draft/POST/DELETE/cancel → 404 | B read A's **draft → 200**; B POST → **202**, cancel → **200**, DELETE → **202** (all authored by B on A's product); harness **5 failed / 2 passed, 7 run** | **CONFIRMED** |

Nothing was NOT REPRODUCIBLE. Nothing was BLOCKED. All five reproduce both on the live
stack and in the integration-test harness.

Durable new specs (all `*.local.spec.ts`, new files only — no upstream file modified):

```
integration-tests/http/offer/store/store-line-item-price-tampering.local.spec.ts   (S1)
integration-tests/http/offer/store/cart-complete-idempotency.local.spec.ts         (S2)
integration-tests/http/order/store/order-detail-pii-leak.local.spec.ts             (S3)
integration-tests/http/offer/vendor/offer-inventory-seller-link.local.spec.ts      (S4-CODE)
integration-tests/http/product/vendor/product-ownership.local.spec.ts              (S5)
```

G1 proof (pristine, overlays not applied):
```
$ git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"
            (empty)
$ git status --porcelain | grep '^??'
?? integration-tests/http/offer/store/cart-complete-idempotency.local.spec.ts
?? integration-tests/http/offer/store/store-line-item-price-tampering.local.spec.ts
?? integration-tests/http/offer/vendor/offer-inventory-seller-link.local.spec.ts
?? integration-tests/http/order/store/order-detail-pii-leak.local.spec.ts
?? integration-tests/http/product/vendor/product-ownership.local.spec.ts
```

---

## S1 / P0.1 — price tampering  — CONFIRMED

Root cause (re-read at source): `packages/core/src/api/store/carts/[id]/line-items/validators.ts`
carries `unit_price` and `compare_at_unit_price` as optional fields, and
`route.ts:14` destructures only `{ additional_data, metadata, offer_id, ...item }`,
spreading `...item` (which still contains the price fields) into the add-to-cart
workflow.

Live repro (offer `offer_01M22BJGCMSJ2BQ49JP82GF5NY`, 44 EUR, qty 5). Each probe uses
a fresh cart + the public publishable key, no auth:

```
### S1-E baseline (no unit_price)   HTTP 200   cart.total=220  item unit_price=44
### S1-A tampered unit_price:1      HTTP 200   cart.total=5    item unit_price=1
### S1-B compare_at_unit_price:1    HTTP 200   cart.total=220  item unit_price=44   (field accepted, not rejected)
### S1-C unit_price:-100            HTTP 500   error type=unknown_error
### S1-D both fields                HTTP 200   cart.total=5    item unit_price=1
### control bogus field             HTTP 400   Unrecognized fields: 'bogus'         (.strict() DOES reject unknown keys)
```

The `bogus` control proves the fix mechanism: `.strict()` already rejects unrecognized
keys with a clean 400 — removing the two price fields from the validator is sufficient.

Harness run (pristine):
```
$ bun run test:integration:http -- http/offer/store/store-line-item-price-tampering.local.spec.ts
Tests:       4 failed, 1 passed, 5 total
  S1-A unit_price:1             Expected 400, Received 200
  S1-B compare_at_unit_price:1  Expected 400, Received 200
  S1-C unit_price:-100          Expected 400, Received 500
  S1-D both fields              Expected 400, Received 200
  S1-E normal add               PASSED (unit_price resolved to 4400, total 22000)
```

**Gates this reproduction will satisfy at re-run:** S1-A, S1-B, S1-C, S1-D, S1-E. (G7,
S0-B: 5 tests executed, 4 red.) S1-F/G/H/regression are patch-read gates for QC, not
runtime.

---

## S2 / P0.2 — duplicate orders  — CONFIRMED

Root cause (re-read at source): `complete-cart-with-split-orders.ts:82-84` selects
`fields:["cart_id"]` for the `order_group` lookup, so `orderGroup?.data?.id`
(line ~101) is `undefined` unconditionally, the `when("create-order-group", …,
({orderGroupId}) => !orderGroupId)` guard is always true, and the create branch runs
on every entry.

### Sequential (deterministic, layer-1 case)

Live: one fully-built cart `cart_01M24WZ33B02PEATQ55Z5DWW30`, completed twice.
Counts are `order_groups | orders | distinct_orders | commission_lines |
payment_collections | reservations | reserved_qty | completed_at_set`:

```
complete #1  HTTP 200  order_group.id=og_01M24X0JJN6G19SY8EZPHCHBDF   counts: 1|1|1|1|1|1|1|t
complete #2  HTTP 200  order_group.id=og_01M24X0JWJRJYGAJX52WKZYERF   counts: 2|2|2|2|1|2|2|t
```

Second complete on a cart with `completed_at` already set returns **200 with a brand-new
order group** — a refresh of the confirmation page duplicates the order. (Post-fix:
409, counts unchanged.)

### True concurrent race (S2-D / S2-E)

Live: one fresh never-completed **2-seller** cart `cart_01M24X1E064PT89GEF2PVA007W`
(total 230), 5 completes fired from a single client via `threading.Barrier(5)`. S2-E
evidence that it actually raced:

```
last request dispatched at t=0.0008s
first response resolved  at t=0.2330s
ALL 5 DISPATCHED BEFORE ANY RESOLVED: True
per-request statuses: [200, 200, 200, 200, 200]   (5 distinct order_group ids returned)
```

All six S2-D conditions, measured on the DB afterwards:

```
counts: 5 order_groups | 10 orders | 10 distinct | 10 commission_lines | 1 payment_collection | 10 reservations | reserved_qty 10 | completed_at t
orders per seller:  sel_…BYE = 5,  sel_…0F8 = 5          (expected 1 each; got 5)
reservations/item:  iitem_…H11 rows=5 qty=5,  iitem_…ES7 rows=5 qty=5   (expected once)
payment_collection: pay_col_…15XP amount=230 eur         (single payment for 5 duplicated fulfilments)
```

So: 5 order groups (want 1), 10 orders = 5× the 2 sellers (want 2, one per seller),
10 commission-line sets (want 1), stock reserved 5× (want 1×), a **single** 230 EUR
payment covering all five — duplicate fulfilment obligations against one payment, and
no response 5xx'd (condition 6 already holds today; the defect is over-creation, not
erroring).

Harness run (pristine):
```
$ bun run test:integration:http -- http/offer/store/cart-complete-idempotency.local.spec.ts
Tests:       2 failed, 2 total
  S2-A sequential #2   order_group count Expected 1, Received 2
  S2-D 5 concurrent    order_group count Expected 1, Received 5
        (the S2-E overlap assertion lastDispatch < firstResolve passed before this line,
         so the race is demonstrably concurrent, not a serialised loop)
```

**Gates this reproduction will satisfy at re-run:** S2-A (sequential → 409), S2-D (race
→ 1 group, all six conditions), S2-E (overlap demonstrated — `Promise.all` over 5
requests, all dispatched before any resolved). S2-C (direct double workflow invocation),
S2-F/G/J (happy / payment-error / re-entry) are gates the **dev** must add inside the
overlay and that QC re-runs; my pass-1 harness test covers the route-observable S2-A and
S2-D, and S2-B is a patch-read gate. I did **not** invoke the workflow container-directly
twice (S2-C) this pass — flagged under "not tested".

---

## S3 / P0.5 — order-detail PII leak  — CONFIRMED

Root cause: `packages/core/src/api/store/orders/[id]/route.ts` passes only
`filters:{ is_draft_order:false }` to `getOrderDetailWorkflow` and never `customer_id`,
while the sibling list route `…/orders/route.ts` passes
`customer_id: req.auth_context.actor_id`.

**QC amendment verified at Medusa source.** The matcher is unauthenticated by design:
```
node_modules/.bun/@medusajs+medusa@2.20.1+…/…/api/store/orders/middlewares.js
  line 45  matcher "/store/orders"           + authenticate("customer", ["session","bearer"])
  line 53  matcher "/store/orders/:id"       (NO authenticate)
  line 60+ matcher "/store/orders/:id/transfer/{request,cancel}"  + authenticate
```
So on `:id`, `req.auth_context` is `undefined` and a naive `actor_id` dereference would
500 — the fix must establish/handle the context (gate S3-B option ii preferred).

Live repro (real order `order_01M24X1F5CXVS7ASHKCNN1S7CN`, publishable key only, no
customer JWT):
```
GET /store/orders/:id   HTTP 200    LEAKED:
  email=repro@mercur.local   total=178 eur   display_id=28
  ship name=Repro Tester     address_1=1 Test St   city=Berlin  postcode=10115  country=de
control GET /store/orders (list)          HTTP 401 Unauthorized
control GET /store/order-groups/:id       HTTP 401 Unauthorized
```
The two sibling routes correctly 401 with the same key — so this is a missed guard on
one route, not a design choice.

Harness run (pristine):
```
$ bun run test:integration:http -- http/order/store/order-detail-pii-leak.local.spec.ts
Tests:       2 failed, 2 passed, 4 total
  S3-A pub-key only            Expected [401,404], Received 200   (PII leak)
  S3-C other customer's order  Expected 404,       Received 200   (cross-customer read)
  S3-D own order               PASSED (200)
  S3-E ?customer_id= in query  PASSED (400 "Unrecognized fields: 'customer_id'" — not widened)
```
(The `Connection ended unexpectedly` lines in the log are teardown noise, not failures.)

**Gates this reproduction will satisfy at re-run:** S3-A (→ 401/404, not 500), S3-C
(other customer → 404), S3-D (own order → 200 unchanged), S3-E (client `customer_id`
does not widen). S3-B/F/G/H are patch-read / dev-decision gates.

---

## S4 / P0.4 — inventory→seller link  — CONFIRMED

Root cause (re-read at source): `create-offers.ts:122-125`
```ts
const sellerId = transform({ input }, ({ input }) => input.offers[0]?.seller_id ?? "")
linkSellerInventoryItemStep({ seller_id: sellerId, inventory_item_ids: createdInventoryItemIds })
```
Every inventory item in the batch is linked to **offers[0]**'s seller, and the
`?? ""` is a second latent bug (empty batch → link to seller `""`).

### Code defect reproduced at the workflow level (S4-C1)

Direct `createOffersWorkflow` call with a genuine 2-seller batch (seller A + seller B,
one offer each):
```
$ bun run test:integration:http -- http/offer/vendor/offer-inventory-seller-link.local.spec.ts
Tests:       1 failed, 1 total
  S4-C1   seller B's inventory item
          Expected (its own offer's seller) "sel_…95S2"
          Received (offers[0].seller_id)    "sel_…F1Z"   ← linked to seller A
```
This is the defect directly: B's item lands on A.

### Live data skew and repair-mapping unambiguity

```
current inventory_inventory_item_seller_seller:   sel_…29A = 1144   (all of them)
offer-derived correct ownership:                  240 / 237 / 226 / 222 / 219  (= 1144)
   sel_…0F8=240  sel_…3VQ=237  sel_…29A=226  sel_…1WD=222  sel_…BYE=219
repair-mapping check (inventory_item → offer_inventory_item → offer.seller_id):
   link_rows=1144  distinct_items=1144  distinct_offers=1144
   items_with_MULTIPLE_sellers = 0     items_with_MULTIPLE_offers = 0
   items linked but resolving to NO offer = 0        seller_id='' rows = 0
```
So the repair is **1:1 and unambiguous** — no item resolves to >1 seller (S4-D1/D2
target distribution matches the PO exactly).

### Boundary consequence (S4-EFFECT, live)

Item `iitem_01M22BJFZRG8Q193BW3WQ5XR2S` is offer-owned by seller B (sel_…0F8) but
currently link-owned by seller A (sel_…29A):
```
B  GET /vendor/inventory-items/{item}                         HTTP 404   (B cannot manage its OWN stock — broken for 4/5 sellers)
A  GET /vendor/inventory-items/{item}                         HTTP 200   (A reads a rival's item)
B  POST …/{item}/location-levels/batch  stocked_quantity=999  HTTP 404
A  POST …/{item}/location-levels/batch  stocked_quantity=999  HTTP 200   (A can zero/alter a rival's stock)
```
`validateSellerInventoryItem` is itself correct — it is operating on wrong link data.

**Gates this reproduction will satisfy at re-run:** S4-C1 (per-item seller link). The
live evidence backs S4-D1/D2 (unambiguous 1:1, target distribution) and S4-E1/E2/E3
(boundary). S4-C2 (empty-batch / `?? ""`), S4-C3/C4/C5/C6/C7 (graph body, compensation,
shared caller) and the S4-DATA script gates (D3/D4/D5/D6/D7) are **dev** deliverables QC
re-runs; my pass-1 spec asserts the core C1 mapping only.

---

## S5 / P0.3 — vendor product routes  — CONFIRMED

Root cause (re-read at source, `packages/core/src/api/vendor/products/middlewares.ts`):
```
GET    /vendor/products/:id          middlewares: [ validateAndTransformQuery ]   + policies:[product.read]
POST   /vendor/products/:id          middlewares: [ validateAndTransformBody, validateAndTransformQuery ] + policies:[product.update]
DELETE /vendor/products/:id          middlewares: []                              + policies:[product.delete]
POST   /vendor/products/:id/cancel   middlewares: [ validateAndTransformBody ]    + policies:[product.update]
```
The only tenant boundary is `policies:[…]`, which is **inert with `rbac=false`**
(this instance's default; `ensure-seller-middleware.ts` early-returns before role
resolution when the flag is off). Run with rbac off, exactly as gate S5-F requires.

Vendor auth: member login (`POST /auth/member/emailpass`, password `supersecret`) +
`x-seller-id` header. Seller A = peakpace (`sel_…29A`), Seller B = kickz (`sel_…0F8`).

Live repro — B attacks A's product (`prod_01M24X88TDD2YTT54AZEVFS8R3`, a draft owned
by A, absent from B's list):
```
B list contains the draft?  False      (so B's detail read must 404 — QC S5-D consistency)
### S5-D  B GET   /vendor/products/{A draft}          HTTP 200   LEAKED title="S5-REPRO DRAFT (A secret)" status=draft
### S5-A  B POST  /vendor/products/{A draft}          HTTP 202   product_change authored by B (created_by=sel_…0F8)
### S5-C  B POST  /vendor/products/{A draft}/cancel   HTTP 200   cancels B's change on A's product
### S5-B  B DELETE /vendor/products/{A draft}         HTTP 202   product_change (delete) authored by B
### S5-E  A POST  own draft (control)                 HTTP 202
product_change rows on A's draft, created_by column:
  …K55  confirmed  sel_…29A (A, the original create)
  …012  canceled   sel_…0F8 (B)
  …ZEM  confirmed  sel_…0F8 (B)      ← B's cross-tenant writes landed as legitimate
  …FZC  pending    sel_…29A (A)
```

Harness run (pristine, rbac off):
```
$ bun run test:integration:http -- http/product/vendor/product-ownership.local.spec.ts
Tests:       5 failed, 2 passed, 7 total
  S5-F rbac flag is off                  PASSED (FeatureFlag.isFeatureEnabled('rbac') === false)
  S5-E A reads+writes own product        PASSED (GET 200, POST 202)
  S5-D B reads A's draft                 Expected 404, Received 200   (draft absent from B's list)
  S5-A B POST A's product                Expected 404, Received 202
  S5-B B DELETE A's product              Expected 404, Received 202
  S5-C B cancel A's product              Expected 404, Received 200
  S5-L body seller_id does not widen     rejected (400 strict body) — defense-in-depth, asserts ≥400
```

**Gates this reproduction will satisfy at re-run:** S5-A, S5-B, S5-C, S5-D (draft-leak
half of the consistency gate), S5-E, S5-F (enforcement with rbac off), S5-L. S5-G
(NOT_FOUND not FORBIDDEN), S5-H/I/J/K (policy preservation, matcher coverage, validator
pairing) are patch-read gates for QC.

---

## What I could NOT test this pass, and why

- **S2-C — direct double invocation of `completeCartWithSplitOrdersWorkflow` at the
  container level.** My S2 pass-1 spec drives the defect through the HTTP route
  (S2-A + S2-D), which already reproduces it. S2-C isolates the workflow guard from the
  route guard and is most meaningful *after* the fix (to show the `createdOrderGroup?.id
  ?? orderGroupId` transform returns the existing group). I will add it at re-run once
  overlay 006 exists, alongside S2-F/G/J which are behaviour the dev introduces.
- **S2-B / S1-F/G/H / S3-B/F/G/H / S4-C2..C7 + S4-DATA / S5-G..K** — these are
  **patch-read** or **dev-deliverable** gates (graph-body shape, compensation, repair
  script idempotency/reversibility/dry-run, matcher coverage, validator pairing). They
  cannot be exercised on a pristine tree because the code they check does not exist yet;
  QC re-runs them against the applied overlays.
- **S4 in a fresh integration-test DB via the HTTP API.** The three HTTP offer callers
  (`vendor/offers`, `vendor/offers/batch`, `admin/offers/batch`) each stamp a single
  `seller_id`, so a single-seller batch links correctly "by accident" and the skew does
  **not** reproduce through the API. The code defect is only reachable by a multi-seller
  batch — which is why my S4 spec invokes `createOffersWorkflow` directly, and why the
  live skew exists only because the seeder is the one caller that passes a mixed batch.
  This is a finding, not a gap: any future API that passes a mixed batch collapses the
  boundary.

## Test-data side effects on the live stack (harmless, noted for transparency)

Created during live probing and left in place: several tamper/normal carts; the
duplicate order groups on `cart_01M24WZ33B02PEATQ55Z5DWW30` (2) and
`cart_01M24X1E064PT89GEF2PVA007W` (5, + 10 orders); one draft product
`prod_01M24X88TDD2YTT54AZEVFS8R3` owned by seller A with 4 product_change rows. None of
these affect the reproductions or the repair-mapping counts (which are computed from
`offer_inventory_item`, untouched). The integration-test harness uses its own temporary
database and leaves the live DB alone.
