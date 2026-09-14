# 05 — QC verdict (Stage 5 of 5, pass 2)

Reviewer: mercur-qc, second pass. Input: `01-po-work-order.md`, `02-qc-gates.md`
(my own gates), `03-test-report.md`, `04-dev-log.md`, and the artefacts themselves.
HEAD `ac02b90a8`. Upstream base `a925daf62`. Medusa `2.20.1`.

**Everything below was re-run by me.** I did not accept a single number from the dev
log. Where my result differs from the dev's, my result is the one recorded.

## Verdict summary

| Item | Verdict |
|---|---|
| S1 — store line-item price tampering (`005`) | **PASS** |
| S2 — cart completion idempotency (`006`) | **PASS** (gate S2-B was wrong as written; amended below) |
| S3 — store order-detail customer scope (`007`) | **PASS-WITH-CONDITIONS** |
| S4-CODE — offer→inventory seller link (`008`) | **PASS** |
| S4-DATA — repair script | **PASS-WITH-CONDITIONS** |
| S5 — vendor product ownership (`009`) | **PASS-WITH-CONDITIONS** |

**Overall: SHIP** — the five overlays are correct, materially reduce exposure, and
none of them breaks a currently-clean invariant.

**But do not record P0.3 as closed.** Four sibling matchers on the same product id
are still unguarded, and I verified by inspection that they are exploitable in
exactly the way S5 describes. See ruling (c).

---

## Part A — Global gates, re-run by me

### G1 — merge-base invariant (pristine tree, overlays reverted)

```
$ git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"
(empty)
$ git status --porcelain
(empty)
```

PASS. Note the tree is fully clean — the `git add -N` index wrinkle the dev warned
about in Part C-6 did not reproduce; `apply.sh --revert` removes
`packages/core/src/api/store/orders/middlewares.ts` cleanly.

### G2 — numbering

`005`–`009`, no gaps, no `010`. PASS.

### G3 — one concern per overlay

Files touched, read hunk by hunk:

```
005: api/store/carts/[id]/line-items/validators.ts
006: api/store/carts/[id]/complete/route.ts
     modules/seller/repositories/order-group.ts          <- third file, see ruling (a)
     workflows/cart/workflows/complete-cart-with-split-orders.ts
007: api/store/middlewares.ts
     api/store/orders/[id]/route.ts
     api/store/orders/middlewares.ts (new file)
008: workflows/inventory-item/steps/link-seller-inventory-item.ts
     workflows/inventory-item/workflows/create-seller-inventory-items.ts
     workflows/offer/workflows/create-offers.ts
009: api/vendor/products/middlewares.ts
```

Every hunk is traceable to its item's statement. **No smuggled change found** — no
reformatting, no renames, no drive-by fixes, nothing from Part D's out-of-scope list.
PASS.

### G4 — apply / check / revert

```
$ ./deploy/overlays/apply.sh --check      # pristine
  pending     005-store-line-item-no-client-price.patch
  pending     006-cart-complete-idempotency.patch
  pending     007-store-order-detail-customer-scope.patch
  pending     008-offer-inventory-seller-link.patch
  pending     009-vendor-product-ownership.patch

$ ./deploy/overlays/apply.sh
  applied     001 … 009            (no conflict, no skip)

$ ./deploy/overlays/apply.sh --revert
  reverted    001 … 009            (G1 re-passes, status clean)
```

PASS.

### G5 — build and lint, overlays applied

```
$ bun run lint
$ oxlint --quiet
(clean)

$ bun run build
 Tasks:    12 successful, 12 total
```

PASS. (The turbo run was a cache hit; `.medusa/**` is a declared output and was
restored, and I independently confirmed the compiled tree matched the applied
overlays before every test run — see G7.)

```
$ bun run test:unit
Test Suites: 3 passed, 3 total
Tests:       13 passed, 13 total
```

### G6 — no type escapes

```
$ grep -nE '^\+.*(\bany\b|@ts-ignore|@ts-expect-error)' deploy/overlays/00[5-9]*.patch
(no hits)
```

PASS. One added non-null assertion (`req.seller_context!` in `009`) matches the
pre-existing convention in the same file and is **sound**: `ensureSellerMiddleware`
sets `req.seller_context` at `ensure-seller-middleware.ts:61`, *before* the
`FeatureFlag.isFeatureEnabled("rbac")` early-return at line 67, and `/vendor/*`
(`api/vendor/middlewares.ts:89-103`) is spread before `vendorProductsMiddlewares`.
Not a type escape.

### G7 — red → green, both runs mine, core rebuilt between them

The dev's fourth false-green trap is real and I honoured it: `packages/core` was
rebuilt from source between the two runs and I verified the compiled artefact each
time before running (`grep unit_price .medusa/.../line-items/validators.js` → 2
occurrences pristine, 0 patched; `grep filters.cart_id .medusa/.../order-group.js`
→ absent pristine, present patched).

**RED — `005`–`009` reverted, `packages/core` rebuilt pristine:**

```
FAIL http/offer/store/cart-complete-idempotency.local.spec.ts (23.499 s)
FAIL http/order/store/order-detail-pii-leak.local.spec.ts (15.826 s)
FAIL http/product/vendor/product-ownership.local.spec.ts (10.573 s)
FAIL http/offer/store/store-line-item-price-tampering.local.spec.ts (10.76 s)
FAIL http/offer/vendor/offer-inventory-seller-link.local.spec.ts (7.978 s)
Test Suites: 5 failed, 5 total
Tests:       15 failed, 10 passed, 25 total
```

The 15 red, by name:

```
S2-A sequential complete #2 must not create a second order group
S2-D 5 concurrent completes on one fresh cart -> exactly 1 order group
S2-K two different carts still produce two different order groups
S2-C/S2-J invoking the workflow directly twice returns the pre-existing group
S3-A publishable key only (no customer JWT) must NOT return the order
S3-C customer B must get 404 on customer A's order
S5-D seller B must NOT read seller A's DRAFT (absent from B's list)
S5-A seller B -> POST /vendor/products/{A's id} is 404
S5-B seller B -> DELETE /vendor/products/{A's id} is 404
S1-A unit_price is rejected (400), not applied
S1-B compare_at_unit_price is rejected (400)
S1-C unit_price:-100 is a clean 400, not a 500
S1-D both fields at once are rejected (400)
S4-C1 each created inventory item links to the seller that declared it
S4-C2 no link is ever created for an empty seller_id
```

**GREEN — `005`–`009` applied, `packages/core` rebuilt:**

```
Test Suites: 5 passed, 5 total
Tests:       25 passed, 25 total
```

25 executed both ways (not an exit code — the counts are above). PASS.

**One honest qualification the dev did not make:** gate **S5-C** (`B → POST
/vendor/products/{A}/cancel` → 404) **passes on a pristine tree too**, so the
harness test does not discriminate for that gate. S5-C is evidenced only by stage
3's live probe (HTTP 200 observed pre-fix, `03-test-report.md` §S5). The overlay's
registration on the `/cancel` matcher is correct by inspection
(`009` hunk at `middlewares.ts:211`), but S5-C has **no red→green proof**. Same
class, lower stakes: S1-E, S3-D, S3-E, S4-C4, S4-C5, S5-E, S5-F, S5-L and the
published half of S5-D are controls/regression gates and pass both ways by design —
that is correct, and I am not counting them as reproductions.

### G8 — existing suite, overlays applied

```
http/order http/inventory http/reservation
  Test Suites: 2 skipped, 18 passed, 18 of 20 total
  Tests:       8 skipped, 70 passed, 78 total

http/product http/product-edit http/offer
  Test Suites: 1 skipped, 28 passed, 28 of 29 total
  Tests:       14 skipped, 225 passed, 239 total

http/order/admin/order-list-filters.spec.ts   (the canary that caught the S2 mis-fix)
  Test Suites: 1 passed, 1 total
  Tests:       4 passed, 4 total
```

46 suites, **295 passed, 22 skipped, 0 failed**, covering every surface the gates
name (S2/S3 → `http/order`; S4 → `http/offer` + `http/inventory`; S5 →
`http/product` + `http/product-edit`). I did not re-run the remaining ~49 suites the
dev reported (auth/campaigns/payouts/…); none of them touch a patched file's
surface. PASS.

### G10 — new file inside an overlay

```
$ grep -c "new file mode" deploy/overlays/007-store-order-detail-customer-scope.patch
1
```

and `--revert` deletes `packages/core/src/api/store/orders/middlewares.ts`, leaving
`git status` empty. PASS.

---

## Part B — The three escalations, ruled

### (a) Overlay `006` carries a third file. **ACCEPTED. Gate S2-B was wrong.**

The dev is right and I was wrong. `OrderGroupRepository.findAndCount`
(`packages/core/src/modules/seller/repositories/order-group.ts:60-95`) is a
hand-rolled `WHERE` builder over an allow-list of `id / customer_id / seller_id /
status / sales_channel_id / created_at / updated_at / q`. **A `cart_id` filter is
silently dropped**, so `useQueryGraphStep({ entity: "order_group", filters: {
cart_id } })` was never scoped to the cart. My gate's "minimal repair is
`fields: ["id", "cart_id"]`" would therefore have made the guard match *the newest
order group in the store* and skip order creation for every cart after the first —
silent non-creation of paid orders, strictly worse than the duplicate-creation bug
it replaces. That is not a style disagreement; the gate as written was unsafe.

The third file is the same concern (the guard cannot be correct without it), so G3
is not violated. The dev's evidence is reproducible: the mis-fix breaks
`http/order/admin/order-list-filters.spec.ts`, and with the three-file patch that
spec is **4/4 green** (run above), and `S2-K` in the new spec pins the behaviour
permanently.

**Amended gate, for the record and for cycle 2's baseline:**

> **S2-B (amended).** The workflow guard must resolve the order group *for this
> cart*. Because `OrderGroupRepository.findAndCount` drops unrecognised filters, the
> repair is **both** `fields: ["id", "cart_id"]` **and** an `og.cart_id IN (…)`
> clause in that repository, parameterised in the same shape as the existing
> `customer_id` clause. Selecting `id` alone is a **FAIL**. A regression test that
> completes **two different carts** and asserts two distinct order groups (S2-K) is
> mandatory, not optional.

The repository hunk itself is correct: parameterised placeholders, array-or-scalar
handling identical to the neighbouring clauses, no change to the SQL shape or to any
other filter.

Related, and the dev flagged it first (Part F-1): the drop-unknown-filters behaviour
is a broken-access-control primitive, not a bug. I checked every current
`entity: "order_group"` call site — `store/order-groups/route.ts:17`,
`store/order-groups/[id]/route.ts:22` and the order-group workflows all scope on
`customer_id`/`id`/`seller_id`, which *are* in the allow-list, so **no live leak
today**. It stays a landmine. Cycle 2, high rank.

### (b) Gate S5-F is unsatisfiable in the harness. **SUBSTITUTION ACCEPTED, and I add the proof that was actually missing.**

`integration-tests/medusa-config.ts:23` sets `featureFlags: { rbac: true }`
deliberately, so the literal assertion stage 3 wrote
(`expect(FeatureFlag.isFeatureEnabled("rbac")).toBe(false)`) cannot pass without
reconfiguring the whole suite. My gate was unimplementable as written.

The dev's substitute proof — "the suite runs with policies **active** and S5-A/B/D
were still red on a pristine tree, therefore `policies: [...]` is not a tenant
boundary at any flag setting" — is sound and is genuinely the stronger direction.
I accept it.

But the dev's S5-F **test** is weak and I will say so: it is a source-text grep for
`FeatureFlag|featureFlags` plus `expect(typeof …).toBe("boolean")`, which asserts
nothing. It documents an intent; it does not verify behaviour.

The proof that matters, which nobody had produced, is structural and I verified it
myself:

```
packages/core/src/api/vendor/middlewares/../../middlewares/ensure-seller-middleware.ts
  :61  req.seller_context = { seller_id, seller_member, currency_code }
  :67  if (!FeatureFlag.isFeatureEnabled("rbac")) { return next() }
```

`req.seller_context` is populated **before** the rbac early-return, and the two new
guards are unconditional entries in the `middlewares:` array, so their only input
(`req.seller_context.seller_id`) is present with the flag off. Enforcement therefore
holds with `rbac: false`. **S5-F's intent is met.**

Residual, and it becomes ship condition **C1**: the *fixed* code has never actually
been executed with `rbac=false`. Stage 3 reproduced the *vulnerability* on the live
instance (`MEDUSA_FF_RBAC … false`), but the live `packages/core/.medusa` has been
pristine throughout. Before or immediately after deploy: apply the overlays, rebuild
`packages/core`, restart the API, and re-run stage 3's live B→A probes
(`03-test-report.md` §S5) — four curls, expect 404/404/404/404.

Cycle 2 should add a dedicated rbac-off harness project so this stops being an
argument. It is **not** a ship blocker.

### (c) S5-I descoped: `/vendor/products/:id/variants/:variant_id` still has `middlewares: []`. **ACCEPTABLE TO SHIP — but the dev's description understates it, and P0.3 must not be marked closed.**

The dev's table says of the sub-routes: "handler reads `req.seller_context!.seller_id`
— scoping exists but I did **not** verify it is an ownership assertion." I verified.
**It is not.** In all four handlers the seller id is used *only* as the `created_by`
stamp on the change record:

```
api/vendor/products/[id]/variants/route.ts:38                 sellerId -> created_by
api/vendor/products/[id]/variants/[variant_id]/route.ts:43,79 sellerId -> created_by
api/vendor/products/[id]/attributes/batch/route.ts:15         sellerId -> created_by
```

`req.params.id` is passed to `productEditUpdateVariantsWorkflow` /
`productEditUpdateAttributesWorkflow` with no ownership check at all, and
`DELETE /vendor/products/:id/variants/:variant_id` additionally has
`middlewares: []` (`middlewares.ts:291-299`). So seller B can still add, edit and
remove variants on seller A's product, and rewrite its attributes, producing exactly
the "admin queue shows B's change as legitimate" outcome the PO described for P0.3.
The overlay closes four matchers and leaves four equivalent ones open on the same
resource.

I still rule it **shippable**, for three reasons: the item's stated and tested
surface is closed; the change is strictly an improvement over today; and the right
guard for the sub-routes is genuinely an **open product question**, not laziness —
it is the same question as S5-D. `ensureSellerOwnsProductParam` would 404 a seller
adding a variant to a published shared-catalogue product it is not assigned, and
whether that is a legitimate contribution flow is the PO's call, not the dev's and
not mine. Choosing wrongly here would break real vendor work.

Conditions, all three mandatory:

- **C2** — cycle 2, item 1: PO decides per sub-route whether the guard is
  ownership (`ensureSellerOwnsProductParam`) or visibility
  (`ensureSellerCanViewProduct`), then all four matchers get one.
- **C3** — the private upstream disclosure of P0.3 must name these four matchers.
  Reporting only `GET/POST/DELETE/:id` + `/cancel` would tell upstream the hole is
  smaller than it is.
- **C4** — no artefact may state that P0.3 is closed. It is *partially* closed.

---

## Part C — Per-item findings

### S1 — `005` — **PASS**

The fix is the deletion of two lines; `.strict()` at `validators.ts:12` does the
rest. S1-A/B/C/D red→green (four tests), S1-E control green both ways with the
server-resolved price. S1-C is a clean 400 from the unrecognised-key branch, not a
`.positive()` refinement — the field is gone, which is what the gate demanded.
S1-F: no arithmetic, no `.toNumber()`, `route.ts` untouched. S1-G: verified
`api/store/carts/middlewares.ts:48-52` still registers
`validateAndTransformBody(StoreAddCartLineItem)` for the exact matcher
`POST /store/carts/:id/line-items`, and the patch does not touch that file. S1-H:
build green with no compensating cast; the symbol has exactly three references
repo-wide (validator, route, middleware registration), so the narrowed type leaks
nowhere.

### S2 — `006` — **PASS**

Three layers, all present. S2-A (409, nothing created), S2-C/J (direct double
workflow invocation returns the pre-existing group — so `validateCartPaymentsStep`
does not throw on re-entry, which was my Part C-4 worry), S2-D + S2-E (five requests
demonstrably overlapped — `lastDispatch < firstResolve` asserted before the
assertions — then exactly 1 order group, 2 orders for 2 sellers, one commission line
per item, one reservation per item, one payment collection, no 5xx), S2-K (two carts
→ two groups). All four red on a pristine tree, all four green applied.

S2-H/S2-I verified at source on the applied tree: the only workflow change is
`fields`; `when("create-order-group", …).then()` unchanged, `orderGroupId` still
produced by `transform`, `acquireLockStep` still first (so the guard's read is
serialised behind the lock — that is what makes S2-D work), `releaseLockStep` still
outside the branch, `idempotent: false` / `retentionTime` untouched, no step lost a
compensation, `updateCartsStep([updateCompletedAt])` still inside the create branch.
S2-G: the new check sits before the workflow call, so the
`PAYMENT_AUTHORIZATION_ERROR` → 200-with-cart branch is untouched, and because
`completed_at` is only written on success a failed payment still allows a retry.

Minor, not a defect: the route adds one `query.graph` on `cart` per complete call,
and an unknown cart id falls through to the workflow's existing error exactly as
before.

### S3 — `007` — **PASS-WITH-CONDITIONS**

S3-A and S3-C red→green; S3-D and S3-E green both ways. Mechanism is option (i), and
the dev is right that option (ii) — the one my gate called "preferred" — is
unusable: with no `authenticate` on the matcher, `req.auth_context` is undefined for
the *legitimate* customer too, so a handler-only guard would 401 everyone. Second
gate of mine that was wrong; recorded.

S3-G verified: the new matcher is `/store/orders/:id` with `method: ["GET"]` exactly,
so `POST /store/orders/:id/transfer/{accept,decline}` keep their intentional
token-bearing unauthenticated behaviour. S3-H verified: `dist/api/store/orders/
middlewares.js` is **not** in the `OVERRIDES` list of
`packages/core/src/utils/disable-medusa-middlewares.ts:26-44`, so Medusa's own entry
for the matcher still runs `validateAndTransformQuery` and the overlay does not
re-register it — no double transformation. S3-F: `is_draft_order: false` retained.
S3-E: scope is server-derived; a query-string `customer_id` is still rejected 400 by
the strict param validator.

Conditions:

- **C5 (product decision, before deploy).** The dev's grep is correct and complete —
  `apps/storefront/src/lib/data/orders.ts:33` `retrieveOrder` always sends auth
  headers, and its only two call sites are the confirmation page and the return
  page. But a **guest** who checks out and lands on `/order/{id}/confirmed` has no
  token, so that page now 401s → `notFound()`. This is a real user-visible
  regression and it is unavoidable given the item. The PO must choose: accept it,
  ship a signed post-checkout token, or redirect guests into the order-claim flow.
  Do not discover this in production.
- **C6 (cheap hardening, recommended not required).** The handler dereferences
  `req.auth_context.actor_id` unguarded. It fails closed today (a missing middleware
  yields a `TypeError` → 500, not a leak), but a downstream consumer that composes
  its own `storeMiddlewares` without spreading Mercur's would get 500s instead of
  401s. `req.auth_context?.actor_id` plus an explicit `UNAUTHORIZED` throw costs two
  lines and makes the failure mode legible.

### S4-CODE — `008` — **PASS**

S4-C1 and S4-C2 red→green. The per-offer mapping is built in a `transform` over
`inventoryItemsToCreate.offerSpans`, the mapping the file already computes and
already consumes at `create-offers.ts:237-250` — no second mapping invented, no loop
over the step, nothing read outside a `transform` (S4-C3). `offerSpans` is
guaranteed 1:1 with `input.offers`: every offer must declare at least one inventory
item or the transform throws `INVALID_DATA` (`create-offers.ts:86-91`), so
`span` can never be undefined.

S4-C4 is the gate I expected to break, and it holds: both the invoke and the
compensation build their payload from the same `toLinkDefinitions(pairs)` helper, so
they are the same rows by construction, and the test forces a post-link failure and
asserts the link-row count is unchanged. S4-C5: the second caller,
`createSellerInventoryItemsWorkflow`, is updated in the same overlay and keeps
single-seller behaviour, with a test. S4-C2: `?? ""` is gone and replaced by a loud
`INVALID_DATA` naming the item. S4-C6: writes still go through the step's
`remoteLink`. S4-E4: `validateSellerInventoryItem` and the vendor inventory-items
routes are untouched. S4-C7: `http/offer` + `http/inventory` green (batch above).

One residual worth stating: S4-C4 exercises rollback on a **single-seller** batch.
The mixed-batch compensation is correct by construction (shared helper) but is not
directly tested. Not a FAIL; a note for whoever extends this.

### S4-DATA — repair script — **PASS-WITH-CONDITIONS**

I re-ran the script myself against the live database and inspected the table
directly.

**Ambiguity abort is real.** `repair-inventory-seller-links.ts:159-195` computes
`ambiguous` (items resolving to 0 or >1 sellers) and `unresolvable` (linked items
with no offer) and `throw`s before the first write, which does not happen until
lines 231-235. The read is sound: `inventory-item-seller-link.ts` declares
`{ inventoryItem, isList: true }, seller`, i.e. one seller per item, so
`fields: ["id", "seller.id"]` cannot silently truncate; and `offer_inventory_item`
is many-to-many, so an item shared across two sellers' offers *would* land in
`ambiguous`. **D2 PASS.**

**Idempotent — verified by me, second consecutive run:**

```
$ bun x medusa exec ./src/scripts/repair-inventory-seller-links.ts
current inventory_item ↔ seller links: 1144 { …29A: 226, …0F8: 240, …3VQ: 237, …1WD: 222, …BYE: 219 }
offer-derived ownership: 1144       { identical }
rows to dismiss: 0
rows to create:  0
nothing to do — links already match offer-derived ownership
```

**D3 PASS.** **D1 PASS** — and confirmed straight from Postgres:

```
$ psql -d mercur -c "select seller_id, count(*) from inventory_inventory_item_seller_seller where deleted_at is null group by 1 order by 2 desc;"
 sel_…0F8 | 240
 sel_…3VQ | 237
 sel_…29A | 226
 sel_…1WD | 222
 sel_…BYE | 219
```

240/237/226/222/219 = 1144, the PO's target exactly. **D5 PASS** (dry run is the
default and returns before the write block). **D6 PASS** (`ContainerRegistrationKeys.LINK`,
no raw SQL). **D7 PASS** (header comment lines 11-14).

**A fact the dev did not report, which anyone auditing this table needs.** The raw
row count is **2062**, not 1144:

```
$ psql -d mercur -c "select count(*) from inventory_inventory_item_seller_seller;"
 2062
```

`link.dismiss` is a **soft delete** — the 918 wrong pairs are tombstoned with
`deleted_at` set, not removed. The live behaviour is correct (all live indexes are
`WHERE deleted_at IS NULL`) and this is Medusa's normal link semantics, but the
dev's log reads as though rows were deleted. It also means the script's own read
path cannot see the tombstones, which is fine but worth knowing before someone
"fixes" a double count.

Conditions:

- **C7** — `dismiss` then `create` are two calls with no transaction around them
  (lines 231-235, and 122-127 on the restore path). A crash between them leaves
  items unlinked, i.e. every affected seller loses access to their own stock until
  the snapshot is restored. **Keep both snapshots in `apps/api/.medusa/` until the
  next cycle closes**, and never run `restore` against a database other than the one
  the snapshot came from — the restore path trusts the file blindly and validates
  nothing.
- **C8** — D4 (reversibility) is evidenced by the dev's round trip plus matching
  sha256 over the two snapshots. I did not re-run the destructive round trip against
  the live DB, because the DB is now in the desired state and a failed restore would
  cost more than the evidence is worth. The code path is straightforward and the
  snapshot exists; I accept D4 on that basis and say so rather than implying I
  re-ran it.

### S5 — `009` — **PASS-WITH-CONDITIONS** (conditions C1–C4 above)

S5-D (draft), S5-A, S5-B red→green; S5-C green both ways (see G7 qualification);
S5-E, S5-F, S5-L and the published half of S5-D green as controls. G8 shows
`http/product` and `http/product-edit` unaffected.

S5-G verified at `helpers.ts:86-93`: `ensureSellerOwnsProduct` throws
`MedusaError.Types.NOT_FOUND` → 404, never `FORBIDDEN`, and rejects the whole
request rather than filtering to empty. S5-H: every `policies: [...]` block is
preserved. S5-K: ownership runs **after** `validateAndTransformBody` in both POST
lists, so `req.validatedBody` is still populated, and `DELETE`'s `middlewares: []`
became `[ensureSellerOwnsProductParam]` rather than `[]` plus a handler call —
exactly as the gate required. S5-L: seller id comes only from `req.seller_context`.

S5-D deserves credit: extracting `sellerVisibleProductPredicate` so the list filter
and the detail guard share one definition is the right shape, better than the
duplicate check I would have accepted. List and detail cannot drift.

No privilege-escalation path via the "authored" half of the ownership semantics:
`getSellerOwnedProductIds` keys on `PRODUCT_ADD` change actions only, and a
cross-tenant `POST /vendor/products/:id` produces an `UPDATE`, so the pre-fix
attacks recorded on the live DB do not grant B lasting ownership of A's product.

---

## Part D — Defects found in review that the dev did not report

1. **The four unguarded `:id` sub-route matchers are confirmed, not merely
   unverified.** Ruling (c). The dev wrote "did not verify"; I verified, and they
   are open. This is the most important line in this document.
2. **`link.dismiss` is a soft delete**, so the repair leaves 918 tombstones and the
   raw table count is 2062. Correct behaviour, undisclosed.
3. **S5-C has no red→green proof** — it passes on a pristine tree in the harness.
   The gate is met by inspection plus stage 3's live probe, not by the spec.
4. **Gate S2-B and gate S3-B were both wrong as written** (unsafe, and
   unimplementable, respectively). Both are my errors, both are corrected above.
   Cycle 2 inherits the amended wording.
5. **The dev's S5-F test asserts nothing** (`expect(typeof …).toBe("boolean")` plus
   a source grep). Keep it as documentation; do not treat it as coverage. The real
   proof is `ensure-seller-middleware.ts:61` vs `:67`, recorded in ruling (b).

Carried forward from the dev's own Part F, and I endorse all of them:
`OrderGroupRepository` dropping unknown filters (rank high, same class as P0.5);
`apps/api` having no `build` task so nothing under `apps/api/src` is typechecked by
`bun run build`; and the fourth false-green trap (rebuild `packages/core` between
red and green runs) belonging in `LOCAL-SETUP.md` next to the other three — it is
not there yet.

---

## Part E — Ship decision

**SHIP** overlays `005`–`009` and the repair script, subject to:

| # | Condition | Owner | Before deploy? |
|---|---|---|---|
| C1 | Re-run stage 3's four live S5 probes against the **patched** build with `rbac=false` | dev | yes |
| C2 | Cycle 2 item 1: PO decides the guard for the four `:id` sub-route matchers, then all four get one | PO → dev | no |
| C3 | Name those four matchers in the private upstream P0.3 disclosure | PO | before disclosure |
| C4 | No artefact states P0.3 is closed; it is partially closed | all | yes |
| C5 | PO decides the guest post-checkout confirmation-page outcome (401 today) | PO | yes |
| C6 | Recommended: guard `req.auth_context?.actor_id` explicitly in the store order-detail handler | dev | no |
| C7 | Retain both repair snapshots; never restore across databases | dev | yes |

State left behind by this review: all nine overlays **pending**, `git status` empty,
merge-base invariant empty, `packages/core/.medusa` rebuilt from the **pristine**
tree so nothing is stale. `mercur-postgres` and `mercur-redis` were down when I
started and I left them **running** (they were needed for the harness); the live
database is in the repaired state. Nothing was committed.
