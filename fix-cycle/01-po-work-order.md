# 01 — PO work order

Cycle 1. Input: `FIX-PLAN.md` (2026-09-10, incl. §0 runtime results). Base `03bf3ae3c`,
upstream base `a925daf62`. Overlay numbering continues from **005**.

## Cycle goal

Close every **confirmed, remotely reachable** defect that lets an outsider or a rival
seller take money, duplicate an order, read a stranger's PII, or touch another
seller's stock — and ship each one with the adversarial test the existing 414 never
had.

---

## Evidence verification (what I re-checked by hand)

Everything scheduled below was re-read at source, and the runtime claims re-run on the
live stack today. Results:

| Item | Verdict |
|---|---|
| P0.1 | **Confirmed.** `store/carts/[id]/line-items/validators.ts` exposes `unit_price` + `compare_at_unit_price`; `route.ts` destructures only `additional_data, metadata, offer_id`, so both spread into `items:`. |
| P0.2 | **Confirmed, and the plan understates the root cause** — see decision D4. |
| P0.3 | **Confirmed, and broader than reported** — `POST /vendor/products/:id` has no ownership middleware, but neither do **`GET`** (cross-tenant product read) nor **`DELETE`** (`middlewares: []`, zero middleware). See D3. |
| P0.4 | **Confirmed, and it is a code defect, not seeder-only** — see D2. Live DB: `inventory_inventory_item_seller_seller` has 1144 rows, all `sel_…29A`, a seller with only 226 offers. |
| P0.5 | **Confirmed live today.** `GET /store/orders/:id` → **200** unauthenticated with only the publishable key; `GET /store/orders` → 401. The `[id]` route passes `filters: { is_draft_order: false }` and never `customer_id`, while its sibling list route does pass `customer_id: req.auth_context.actor_id`. |
| P0.6 | **Confirmed live today.** `?limit=-1` → 500, `?order=%3Bnope` → 500, `?limit=999999999` → **200, uncapped**. Deferred anyway — see out of scope. |
| P1.1 | Static claim **confirmed** (route has zero seller references; middlewares register validators + an inert policy only). Runtime says not reachable as described. Deferred pending a reproduction. |
| P1.3 | Static claim **confirmed** (`vendor/collections/[id]/products/route.ts` has zero seller references). Deferred — unproven, link tables empty. |
| P2.1 | **Confirmed.** `commission/service.ts` — `@InjectManager()` on `upsertCommissionLines`, doc comment above it says "in a single transaction". |
| P2.4 | **Confirmed.** `rateSpecificity` = `new Set(rules.map(r => r.reference)).size`. Deferred — needs a business decision, not an engineering one. |
| P3.1 | **Confirmed** exactly as the truth table states. Deferred. |

Nothing was dropped for bad evidence. Two items grew (P0.3, P0.4).

---

## In scope — ordered

Rank is by exposure: unauthenticated-and-monetary first, then unauthenticated
disclosure, then authenticated cross-tenant write.

### S0 — Testing traps, written down before stage 3 runs (P0b.1, P0b.2)

Not a defect fix; a **prerequisite**. Stage 3 will otherwise produce false green.

- Backgrounded `jest` exits 0 within seconds having run nothing — always foreground.
- `bun run test:integration:http -- <path>` takes a path **relative to
  `integration-tests/`** (`http/offer`, not `integration-tests/http/offer`). The
  repo-relative form matches zero tests and **exits 0**.
- Never run `bun run build` against a live `next dev` server — it clobbers `.next`
  and the storefront 500s on every route until `rm -rf apps/storefront/.next`.

Files: `LOCAL-SETUP.md` (troubleshooting section) — **direct edit, ours**.
Done when: all three are in `LOCAL-SETUP.md` and stage 3's brief cites them.

### S1 — P0.1 Customers cannot set their own prices

Statement: remove `unit_price` and `compare_at_unit_price` from the **public** store
add-line-item validator so `.strict()` rejects them and price resolves server-side
from the offer.

Why this rank: unauthenticated (publishable key is public by design), directly
monetary, verified end to end — €220 of goods sold for €5, order completed, payment
collection written for the tampered total. Two lines to fix.

Files: `packages/core/src/api/store/carts/[id]/line-items/validators.ts`.
Delivery: **overlay `005-store-line-item-no-client-price.patch`**.

Done when:
- `POST /store/carts/:id/line-items` with `unit_price` → **400** (not 200, not 500).
- Same with `compare_at_unit_price` → 400.
- Same with `unit_price: -100` → **400**, not the current 500 (this closes one of the
  three public 500s in P0.6 for free).
- A normal add still resolves the offer price; the cart total is unchanged from today.
- The existing 414 still pass — no test sends these fields (verified, see D1).

### S2 — P0.2 Cart completion is idempotent

Statement: one cart yields at most one `order_group`, for sequential *and* concurrent
calls.

Why this rank: unauthenticated, monetary, and **deterministic with two sequential
requests** — a customer refreshing the confirmation page duplicates their order.
Reproduced at 5-parallel: 5 order groups, 10 orders, 8 commission lines, one payment,
triple-counted `reserved_quantity`.

Files: `packages/core/src/api/store/carts/[id]/complete/route.ts`,
`packages/core/src/workflows/cart/workflows/complete-cart-with-split-orders.ts`.
Delivery: **overlay `006-cart-complete-idempotency.patch`** (one concern, two files —
the route check and the guard repair are the same concern and must not be split, since
either alone still loses).

Done when:
- Sequential `complete` #2 on a cart with `completed_at` set returns **409** and
  creates nothing.
- 5 parallel completes on one fresh cart produce exactly **1** `order_group`, N orders
  (one per seller), one commission-line set, and `reserved_quantity` counted once.
- The happy path still returns `type: "order_group"` with the created group.

### S3 — P0.5 `GET /store/orders/:id` requires being the customer

Statement: filter the order-detail route on `req.auth_context.actor_id` exactly as the
sibling list route already does.

Why this rank: unauthenticated broken access control on customer PII (email, full
name, street, city, postcode, order total). One route, and the correct code is
literally in the file next to it. ULID ids are not trivially enumerable, which is why
it is third and not first.

Files: `packages/core/src/api/store/orders/[id]/route.ts`.
Delivery: **overlay `007-store-order-detail-customer-scope.patch`**.

Done when:
- Publishable key only, no customer JWT, real order id → **401** (or 404; 401 preferred
  to match `/store/orders` and `/store/order-groups/:id`).
- Customer A's JWT against customer B's order id → 404.
- Customer A's JWT against their own order → 200, unchanged payload.

### S4 — P0.4 Inventory items belong to the seller that created the offer

Statement: fix `createOffersWorkflow` to link each created inventory item to **its
own** offer's seller, then repair the 1144 mislinked rows.

Why this rank: 4 of 5 sellers cannot manage their own inventory, and the fifth can read
and zero every competitor's stock through a legitimately-scoped route (the tester set a
rival's `stocked_quantity` from 1,000,000 to 0 and restored it). Authenticated, so
below the unauthenticated three — but it is a total collapse of the inventory tenant
boundary.

Files:
- `packages/core/src/workflows/offer/workflows/create-offers.ts` — **overlay
  `008-offer-inventory-seller-link.patch`**.
- A new repair script, e.g. `apps/api/src/scripts/repair-inventory-seller-links.ts` —
  **new file, direct add** (adding a new file is always allowed).

Done when:
- `createOffersWorkflow` given a batch spanning two sellers links each item to the
  seller of the offer that declared it — an integration test asserting exactly this
  must exist, because no current test creates a multi-seller batch.
- Post-repair, `inventory_inventory_item_seller_seller` matches the offer-derived
  ownership: 240 / 237 / 226 / 222 / 219 across the five sellers.
- Seller B gets 404 on seller A's inventory item; seller A gets 200 on their own.

### S5 — P0.3 Vendor product writes assert ownership

Statement: assert product ownership on the `/vendor/products/:id` routes, independent
of the `rbac` feature flag.

Why this rank: authenticated cross-tenant write, verified end to end — seller B's edit
to seller A's product reached the admin queue as legitimate and, on confirm, renamed
the product; seller A cannot cancel it. Ranked last of the five only because it needs a
vendor account; the blast radius is otherwise equal to S4.

Files: `packages/core/src/api/vendor/products/[id]/route.ts` and/or
`packages/core/src/api/vendor/products/middlewares.ts`, plus
`packages/core/src/api/vendor/products/[id]/cancel/route.ts`.
Delivery: **overlay `009-vendor-product-ownership.patch`**.

Note for the implementer: `ensureSellerOwnsProduct(scope, sellerId, productIds)`
already exists in `packages/core/src/api/vendor/products/helpers.ts` and is already
used by `vendor/product-categories/[id]/products/route.ts`. Reuse it — do not write a
second helper. Prefer a middleware on the `:id` matchers over per-handler calls, so a
future `:id` sub-route inherits it.

Done when:
- Seller B → `POST /vendor/products/{A's id}` → **404**.
- Seller B → `DELETE /vendor/products/{A's id}` → 404.
- Seller B → `POST /vendor/products/{A's id}/cancel` → 404.
- Seller B → `GET /vendor/products/{A's id}` → 404 (see D3).
- Seller A's own product: all four unchanged.
- Enforcement holds with `featureFlags.rbac = false`, which is this instance's state.

---

## Product decisions

### D1 — P0.1: remove both price fields outright. **Decided: remove.**

I checked for a legitimate sender before deciding:

- **Storefront:** `apps/storefront/src/lib/data/cart.ts:105-160` is the only add-to-cart
  path (`addToCart`, reached from `CartProvider`, `ProductDetailsHeader`, `OfferCard`,
  `CompareOffersModal`). It posts `{ $id, offer_id, quantity }` and nothing else. Every
  other `unit_price` hit in the storefront **reads** it for display
  (`OrderProductListItem`, `CartDropdownItem`, `SingleOrderReturn`).
- **Integration tests:** 23 spec files POST to `/store/carts/:id/line-items`; **none**
  sends `unit_price` or `compare_at_unit_price`. The `unit_price` hits in tests are
  either assertions on the resolved price or admin/vendor order-edit routes, which are
  a different surface. `offer/cart/cart.spec.ts:218` even records the intent:
  *"SPEC-007: Mercur no longer writes a custom unit_price."*

So there is no legitimate sender. Medusa's own store API never exposes `unit_price` —
it is admin/draft-order only. Removal is safe and is the *correct* shape, not a
mitigation. **Do not** substitute a "reject if it differs from the offer price" check:
that keeps a client-supplied money field on a public route for no gain.

What it changes: any third-party client sending these fields starts getting 400. That
is the point.

### D2 — P0.4: this is a **code fix plus a data fix**, not seeder-only. **Decided: both.**

I read the provisioning path before deciding. `packages/core/src/workflows/offer/
workflows/create-offers.ts` creates the inventory items for the whole batch, then:

```ts
const sellerId = transform({ input }, ({ input }) => input.offers[0]?.seller_id ?? "")
linkSellerInventoryItemStep({ seller_id: sellerId, inventory_item_ids: createdInventoryItemIds })
```

Every inventory item in the batch is linked to **`offers[0]`'s seller**, regardless of
which offer declared it. That is shared production code, not seed code — the seeder
(`apps/api/src/scripts/seed.ts:869`) is simply the only caller today that passes a
multi-seller batch, which is why the whole 1144 landed on one seller.

The three API callers happen to be safe *by accident*: `vendor/offers/route.ts`,
`vendor/offers/batch/route.ts` and `admin/offers/batch/route.ts` all stamp a single
`seller_id` across the batch. Nothing enforces that. The `?? ""` fallback is a second
latent bug — an empty batch would link to seller `""`.

Consequence for scope: the overlay is mandatory (a data-only fix regresses the moment
anything calls the workflow with a mixed batch), and it must be tested with a
multi-seller batch, which no existing test does.

Consequence for the repair: the correct owner is **fully derivable and unambiguous**. I
checked on the live DB — `offer_inventory_item` is 1:1 over all 1144 items, and **zero**
items resolve to more than one seller. The repair is `inventory_item → offer →
offer.seller_id`. No judgement calls, no data loss.

The API's ownership check itself is correct and must not be touched.

### D3 — P0.3: ownership is asserted **independently of `rbac`**, and on reads too. **Decided.**

`featureFlags.rbac` defaults to `false` (`packages/core/src/with-mercur.ts:53`) and this
instance runs with it off. Both `ensureSellerMiddleware` and
`resolveAdminRolesMiddleware` early-return before any role resolution when the flag is
off, so **every `policies: [...]` declaration on every vendor and admin route is inert
on this instance**. Any route whose only tenant boundary is a policy has, in effect, no
boundary.

The principle: **RBAC answers "may this member perform this operation?"; ownership
answers "is this resource in this member's tenant?".** They are different questions and
must not share a kill switch. A permission flag that can be turned off is a legitimate
product control; a tenant boundary that can be turned off is not a boundary. Ownership
therefore goes in an always-on middleware, and the policy declarations stay as they are.

Widened scope: `GET /vendor/products/:id` also has no ownership filter and returns any
seller's product detail, and `DELETE /vendor/products/:id` registers
`middlewares: []` — literally nothing. The reported write path is the loudest symptom,
not the whole hole. All of `GET`, `POST`, `DELETE` and `/cancel` are in S5.

Caveat the dev must respect: `ensureSellerOwnsProduct` deliberately allows both
*assigned* products (`product_seller`) and *authored* ones. Products live in a shared
master catalog, so "owns" is not "created". Do not narrow it to authorship — that
would break legitimate resellers.

### D4 — P0.2: the guard is not merely weak, it can never fire. **Decided: fix the cause, keep both layers.**

The plan says the order-group-by-`cart_id` lookup "resolves to nothing on re-entry". The
actual reason is narrower and cheaper to fix:

```ts
useQueryGraphStep({ entity: "order_group", fields: ["cart_id"], filters: { cart_id: input.cart_id }, ... })
const orderGroupId = transform({ orderGroup }, ({ orderGroup }) => orderGroup?.data?.id)
```

The query selects **`cart_id` only**. `data.id` is therefore `undefined` even when a
group exists, so `when(!orderGroupId)` is always true and the create branch always runs.
Adding `"id"` to `fields` is likely the whole workflow-side repair. The dev should
confirm that before writing anything larger.

Still ship **both** layers as the plan says: the route-level `completed_at` → 409 gives
a correct, cheap answer for the overwhelmingly common case (a page refresh), and the
workflow guard plus the existing `acquireLockStep` is what survives a true concurrent
race. Neither alone is sufficient. Note also that `completed_at` is written *inside* the
create branch, so it is only ever set on the first successful pass — the route check is
sound but is not a substitute for the guard.

### D5 — P1.1 (asked in my brief, answered here, executed later): **delete the route, do not scope it.**

`POST /vendor/inventory-items/location-levels/batch` is redundant with
`vendor/inventory-items/[id]/location-levels/batch`, which already does the right thing
(`validateSellerInventoryItem` **and** a force-overwrite of `inventory_item_id: id` on
every entry). The unscoped variant is strictly more dangerous and offers nothing the
scoped one does not. I checked `apps/vendor/src` — no first-party consumer calls it.
Deleting it removes a whole class of bug rather than patching one instance.

Not scheduled this cycle: §0 says it was not reachable as described at runtime, and I
will not spend a slot on a route whose reachability is in question while three
unauthenticated exploits are open. Scheduled for cycle 2 **behind a reproduction** —
if it turns out to be unreachable, the deletion is free anyway.

### D6 — P2.4 commission specificity: **not decided here.** See "Blocked on the human".

---

## Out of scope this cycle — with reasons

| Item | Reason |
|---|---|
| **P0.6** (public 500s, uncapped `limit`) | Real and confirmed live, but no integrity or confidentiality loss and no stack-trace leak. The `unit_price: -100` case is closed free by S1. The uncapped `?limit=999999999` is a genuine resource-exhaustion concern — **first item of cycle 2**. |
| **P1.1 / P1.2 / P1.3** | Unproven at runtime because the relevant seller link tables are empty. Unproven ≠ disproven — they stay scheduled, but gated behind a reproduction. S4 is a prerequisite anyway: once inventory links are correct, the seller-B resources needed to attack P1.2 will finally exist. |
| **P1.4** (route-walking regression guard) | Right idea, wrong cycle. Build it once S5 establishes the shape a compliant `:id` route has, or it will encode the broken pattern as the baseline. |
| **P2.1** (`@InjectTransactionManager`) | Highest value-per-character in the plan and I nearly took it. Excluded because a transaction-boundary change in the money path needs its own failure-injection test, and this cycle is already five overlays. **First code item of cycle 2**, ahead of everything else there. |
| **P2.2** (payout compensation) | Same reasoning, same cycle-2 slot. |
| **P2.3** (BigNumber downcast) | Precision loss accumulates slowly; nothing is being lost this week that is not lost next week. Bundle with P2.1/P2.2 as one "money correctness" cycle, including the 3 `@ts-ignore` in that file. |
| **P2.4** (specificity semantics) | Blocked on the human. Changes what sellers get paid. |
| **P3.1** (seller visibility predicate) | Confirmed and genuinely wrong — a seller who merely *schedules* a future closure vanishes immediately. But it hides sellers rather than exposing anything, and §0 could not exercise it (no closed sellers seeded). Cycle 2. |
| **P3.2 / P3.3 / P4.\*** | Hardening. `deploy/` items are ours and cheap, but they compete with exploits for review attention. Cycle 3. |
| **P5.1** (162 `any`) | **Do not overlay. Ever.** An overlay across 162 upstream call sites is a permanent merge-conflict tax that will outlive the value it delivers. Fix opportunistically only in files an overlay already touches. |
| **P5.2** (docs describe nonexistent scheduled jobs) | The `.claude/skills/mercur/SKILL.md` half is a **direct edit and free**, and it actively misleads every future session. If the dev has slack at the end of the cycle, take it. Not a gate. The upstream doc half stays with overlay `003`. |

---

## Blocked on the human

**One question. It does not block any of S0–S5 — proceed with the cycle.**

**Q1 — P2.4: what does "most specific wins" mean, and who absorbs the correction?**

`commission/service.ts:130` scores specificity as the count of distinct dimensions, so
a rate scoped to one `product` and a rate scoped to one `seller` both score 1 and the
tie breaks on `created_at ASC` — an old store-wide rate beats a product-specific one.
`docs/ARCHITECTURE.md` describes per-reference weight. Code and docs disagree.

I will not decide this, because either answer moves money:

- **(a) Code is right** → correct `docs/ARCHITECTURE.md` and the `mercur` skill. Free,
  no migration, but it means "specific" has never meant what the docs promised sellers.
- **(b) Docs are right** → add a per-reference weight (`product` >
  `product_category`/`product_collection` > `product_type` > `seller`) as the primary
  sort key. Existing rates keep their rows but **some sellers start being paid a
  different rate on their next order**, with no notice and no audit trail.

If (b), I also need: does the change apply only to orders placed after the deploy, or
are already-computed commission lines recomputed? `refreshOrderCommissionLinesWorkflow`
means recomputation is technically possible, which makes "do nothing" an active choice
rather than a default.

Everything else in this plan I decided (D1–D5).

---

## Upstream-report items — private disclosure to mercurjs

All five are defects in upstream Mercur, not in our additions. Our overlays are
stop-gaps; the fix of record must be upstream's. Report **privately, before any public
write-up**, and before publishing any overlay whose diff reveals the exploit.

| Finding | Class | Why it warrants private disclosure |
|---|---|---|
| **P0.1** | Broken access control / price tampering | Unauthenticated with the public publishable key. Any live Mercur store is selling at customer-chosen prices right now. Highest severity in the set — trivially exploitable, directly monetary, and reproduced end to end (€220 → €5, order completed, payment collection written for the tampered total). |
| **P0.2** | Business-logic / idempotency | Unauthenticated. Deterministic with two sequential requests — no race, no tooling. Duplicate fulfillment obligations and duplicate commission lines against a single payment. |
| **P0.3** | Broken access control, cross-tenant write | Any vendor edits or deletes any other vendor's product, and the admin approval queue displays the change as legitimate. Aggravated by the general principle in D3: on a default install (`rbac: false`) **every route policy in the codebase is inert**, so any route relying on a policy as its only tenant boundary has none. Report that principle alongside the instance — it is the more valuable half. |
| **P0.4** | Cross-tenant data integrity | `createOffersWorkflow` links every inventory item in a batch to `offers[0].seller_id`. Latent for the current API callers, which all pass a single seller, but nothing enforces that and one mixed batch collapses the inventory tenant boundary for the whole store. |
| **P0.5** | Broken access control, PII disclosure | Unauthenticated read of customer email, full name, street address, postcode and order total. Confirmed live today: 200 with only the publishable key. The sibling list route is correctly scoped, so this is a missed guard rather than a design choice — a cheap upstream fix. |

**P1.1** and **P1.3** should be mentioned in the same report as *unconfirmed but
statically evident* (an unscoped batch route and an unscoped shared-catalog relink), so
upstream can check them against a fuller dataset than ours. Do not claim them as
confirmed — our seller link tables were empty and we could not attack them.

---

## Constraints stage 2–4 inherit

- **Rule 0** — no upstream-tracked file may be edited *in a commit*. S1–S5 all ship as
  overlays `005`–`009` in `deploy/overlays/`, one concern per patch. New files (the S4
  repair script, every new test) are always fine.
- Invariant, always against the merge-base:
  `git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"` → empty.
- Definition of done, per item: overlay exists → `apply.sh --check` clean →
  `bun run build` 12/12 → `bun run lint` clean → **a test that fails without the overlay
  and passes with it** → merge-base diff still empty.
- **414 tests passed and caught none of S1–S5.** The gap is adversarial coverage, not
  happy-path coverage. An item without a test that would have caught it is not done.
- `bun` only. `bun x`, never `bunx`. Never bare `bun run test:integration:http` — and
  see S0 for the two traps that produce false green.
- Never add `any` or `@ts-ignore`.
- Do not commit unless the human asks. No AI attribution in commits or PRs.
- `.claude/skills/mercur/SKILL.md` claims are unverified until checked.
