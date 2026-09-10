# 02 — QC acceptance gates

Stage 2 of 4. Input: `fix-cycle/01-po-work-order.md`, `FIX-PLAN.md` §0.
Base `03bf3ae3c`, upstream base `a925daf62`, Medusa `2.20.1`.

These gates bind **stage 3 (tester)** and **stage 4 (dev)**. I re-read every file named
in the work order before writing them; where a gate contradicts the PO's literal wording
it is flagged as **[QC-AMENDS-PO]** with the evidence, and my wording governs unless the
PO overrules it.

A gate is written so that there is exactly one way to satisfy it. If a gate looks
satisfiable two ways, one of those ways is the bug — read the "not acceptable" line under it.

Verdict vocabulary for pass 2: **PASS** (gate met, evidence produced) / **FAIL** (not met)
/ **PARTIAL** (met for some sub-cases). No other verdicts. An item is shippable only when
every gate for it is PASS.

---

## Part A — Global gates (every item, no exceptions)

| ID | Gate | How it is proven |
|---|---|---|
| **G1** | The fix to any upstream-tracked file exists **only** as a patch in `deploy/overlays/`. No upstream file is modified in a commit. | `git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"` → **empty output**, run on a tree with overlays reverted. Never compare against `upstream/main` directly. |
| **G2** | Overlay numbering is `005`–`009` exactly as the PO assigned. No renumbering, no gaps, no `010`. | `ls deploy/overlays/*.patch` |
| **G3** | **One concern per overlay.** A patch may touch more than one file only when the files implement a single defect's fix (explicitly permitted: `006` = route + workflow; `008` = workflow + link step; `009` = middlewares + helpers/route). A patch that also fixes typos, reformats, renames, or "while I was in there" changes is a FAIL. | Read the patch hunk by hunk. Every hunk must be traceable to the item's statement. |
| **G4** | `./deploy/overlays/apply.sh --check` reports each new patch `pending` on a pristine tree and `applied` after `apply.sh`; `--revert` returns the tree to pristine (G1 re-passes after revert). | Run all three. Any `conflict` is a FAIL. |
| **G5** | `bun run build` → **12/12**. `bun run lint` → clean. Both from a tree with overlays **applied**. | Command output. A build run against a live `next dev` server does not count (see S0). |
| **G6** | No `any`, no `@ts-ignore`, no `@ts-expect-error`, no non-null `!` added to silence a type the fix itself introduced, in any added or patched line. | `grep -nE '(^\+.*\b(any)\b)|(^\+.*@ts-(ignore|expect-error))' deploy/overlays/00[5-9]*.patch` → no hits that are real type escapes. Existing `req.seller_context!` in untouched lines is not in scope. |
| **G7** | A test exists that **fails on a pristine tree and passes with the overlay applied**, and it is the adversarial case, not the happy path. | Run the named spec twice: overlays reverted → red; applied → green. Paste both outputs. Item-specific tests are listed per item below. |
| **G8** | The existing suite does not regress. The relevant surface groups run green with overlays applied. | `bun run test:integration:http -- <path relative to integration-tests/>`. Never bare. Never backgrounded. |
| **G9** | No behaviour outside the item's stated regression surface changes. In particular: no module-isolation break, no workflow-graph-body violation, no removed compensation, no `.toNumber()` on a monetary value, no new client-supplied scope. | Read the patch against Part B. |
| **G10** | New files (repair script, tests) are added directly — that is always allowed. But a **new file that must live inside an overlay** (because it is imported by a patched upstream file) must be captured with `git add -N <file>` before `git diff`, or `git diff` silently omits it and the overlay ships a broken import. | If any overlay creates a file, its patch must contain a `new file mode` hunk. Verify `apply.sh --revert` deletes it. |
| **G11** | Every gate's evidence is a pasted command + output, not a claim. A self-report without output is treated as FAIL in pass 2. | — |

### Medusa 2.x non-negotiables — which apply where

| Non-negotiable | S1 | S2 | S3 | S4 | S5 |
|---|:--:|:--:|:--:|:--:|:--:|
| Module isolation (no cross-module service import; reads via links+Query, writes via workflows) | – | ✅ | ✅ | ✅ | ✅ |
| Workflow graph bodies (`when`/`transform`/`parallelize`; no plain `if`/`for`/`await`; never read `step.output.x` outside `transform`) | – | ✅ **critical** | – | ✅ **critical** | – |
| Compensation on every writing step (3rd arg to `createStep`; `StepResponse`'s 2nd arg alone does nothing) | – | ✅ | – | ✅ **critical** | – |
| Surface correctness (`admin`/`vendor`/`store` meanings; vendor scope from `req.seller_context`, never client-supplied) | ✅ | ✅ | ✅ | ✅ | ✅ **critical** |
| Fail closed; prefer `NOT_FOUND` over `FORBIDDEN` on tenant mismatch (match `ensure-seller-scope-middleware.ts`) | ✅ | – | ✅ | ✅ | ✅ **critical** |
| Money: BigNumber/`MathBN` end to end, no float arithmetic, no `.toNumber()` before persistence | ✅ **critical** | ✅ | – | – | – |
| `@InjectTransactionManager()` on delete-then-write | – | – | – | – | – |
| No `any` | ✅ | ✅ | ✅ | ✅ | ✅ |
| A route reading `req.validatedBody` has `validateAndTransformBody` for its **exact** matcher | ✅ **critical** | – | ✅ | – | ✅ **critical** |

`@InjectTransactionManager` is out of scope this cycle (P2.1, cycle 2) — but a fix that
*introduces* a delete-then-write path would pull it in. None of S1–S5 should.

### Medusa error type → HTTP status (verified in
`node_modules/.bun/@medusajs+framework@2.20.1+*/…/http/middlewares/error-handler.js`)

| `MedusaError.Types` | Status | Note |
|---|---|---|
| `INVALID_DATA`, `NOT_ALLOWED` | 400 | |
| `UNAUTHORIZED` | 401 | |
| `FORBIDDEN` | 403 | do not use for tenant mismatch |
| `NOT_FOUND` | 404 | |
| `CONFLICT` | **409** | **the handler overwrites the message** with "The request conflicted with another request…". Assert on status, never on message text. |
| anything unmapped | 500 | including a raw `TypeError` from reading a property of `undefined` |

Zod `.strict()` rejections are surfaced as 400 by the same handler's `issues` branch.

---

## Part B — Per-item gates

### S0 — Testing traps recorded before stage 3 runs (P0b.1, P0b.2)

Not a defect fix; a prerequisite. Not an overlay — `LOCAL-SETUP.md` is ours, direct edit.

| ID | Gate |
|---|---|
| **S0-A** | `LOCAL-SETUP.md` contains all three traps, each with the wrong form, the right form, and the observable symptom: (1) backgrounded `jest` exits 0 in seconds having run nothing — always foreground; (2) `bun run test:integration:http -- <path>` takes a path **relative to `integration-tests/`** (`http/offer`, not `integration-tests/http/offer`) — the repo-relative form matches zero tests and **exits 0**; (3) `bun run build` against a live `next dev` clobbers `.next` and every storefront route 500s until `rm -rf apps/storefront/.next`. |
| **S0-B** | Stage 3's brief cites S0-A by section, and stage 3's report states, per spec it ran, the **number of tests executed** — not just the exit code. A stage-3 result reporting only "exit 0" is rejected: that is exactly the false-green signature of traps (1) and (2). |
| **S0-C** | G1 still passes — `LOCAL-SETUP.md` is not upstream-tracked. Confirm before editing, not after. |

**Regression surface:** none (documentation). **Not acceptable:** putting these in
`CLAUDE.local.md` or a fix-cycle note instead — they must be where the next session looks.

---

### S1 — P0.1 Customers cannot set their own prices

**Overlay `005-store-line-item-no-client-price.patch`**
**File:** `packages/core/src/api/store/carts/[id]/line-items/validators.ts`

The fix is the deletion of the two `unit_price` / `compare_at_unit_price` lines from
`StoreAddCartLineItem`. `.strict()` at line 12 then rejects them. That is the whole fix.

| ID | Gate | Expected |
|---|---|---|
| **S1-A** | `POST /store/carts/:id/line-items` with a valid `offer_id`, `quantity`, **plus `unit_price: 1`** | **400**, `type: "invalid_data"`, no line item created, cart total unchanged. Not 200. Not 500. |
| **S1-B** | Same with `compare_at_unit_price: 1` | 400 |
| **S1-C** | Same with **`unit_price: -100`** | **400** — this is the gate the PO called out. Today it is **500**. A fix that turns `-100` into a 400 *by adding a `.positive()` refinement while leaving the field on the validator* is a **FAIL**: it keeps a client-supplied money field on a public route. The field must be gone, and the 400 must come from `.strict()` rejecting an unrecognized key. |
| **S1-D** | Same with both fields at once | 400 |
| **S1-E** | Normal add (`{ offer_id, quantity: 5 }`) against the offer used in the §0 repro | 200; `unit_price` resolves **server-side from the offer**; `subtotal` and `total` byte-identical to the pre-fix normal-path values (the §0 repro's 220 EUR, not 5). |
| **S1-F** | Money non-negotiable | The patch performs **no** arithmetic on a monetary value, adds no `.toNumber()`, and does not touch `route.ts`'s `...item` spread. Price resolution stays entirely in `addToCartWorkflow`. |
| **S1-G** | Validator/middleware pairing | `packages/core/src/api/store/carts/middlewares.ts` still registers `validateAndTransformBody(StoreAddCartLineItem)` for the exact matcher `POST /store/carts/:id/line-items`. The patch must not touch this file — if it does, G3 applies. |
| **S1-H** | Type surface | `StoreAddCartLineItemType` narrows by two optional fields. `bun run build` must be green **without** adding a cast anywhere to compensate. A `as` cast introduced in `route.ts` to paper over the narrowed type is a FAIL. |

**Test (G7):** an adversarial spec under `integration-tests/http/offer/store/` (or the
existing cart spec's file) asserting S1-A/B/C/D/E. It must be **red** on a pristine tree
for S1-A specifically (today: 200 with a tampered total).

**Regression surface — must NOT change:**
- The happy-path add. `offer_id`, `quantity`, `metadata`, `additional_data` all still accepted;
  `metadata` still merged with `{ offer_id }`; `requires_shipping: true` still forced.
- The offer-not-found path still 404.
- `apps/storefront/src/lib/data/cart.ts:105-160` posts `{ $id, offer_id, quantity }` only —
  the storefront must remain functional end to end; do not "fix" it, it needs no change.
- Every other `unit_price` surface — admin/draft-order routes, vendor order-edit routes,
  and the storefront's **read** sites (`OrderProductListItem`, `CartDropdownItem`,
  `SingleOrderReturn`) — is out of scope and must be untouched.

**Plausible breakage to watch for:** a third-party client that sends these fields now gets
400. That is the intent (D1), and it must be stated in the overlay header comment.

---

### S2 — P0.2 Cart completion is idempotent

**Overlay `006-cart-complete-idempotency.patch`**
**Files:** `packages/core/src/api/store/carts/[id]/complete/route.ts`,
`packages/core/src/workflows/cart/workflows/complete-cart-with-split-orders.ts`
Two files, **one concern** — the PO is right that splitting them loses. Do not split.

Root cause is settled (D4) and I re-verified it at source: line 84 of the workflow queries
`entity: "order_group"` with `fields: ["cart_id"]`, so `orderGroup?.data?.id` at line 97 is
`undefined` unconditionally and `when("create-order-group", …, ({ orderGroupId }) => !orderGroupId)`
at line 105 is always true.

**Both layers are mandatory.** A route-only fix is a FAIL, and I will check for it explicitly.

| ID | Gate | Expected |
|---|---|---|
| **S2-A** *(layer 1, route)* | Sequential complete #2 on a cart whose `cart.completed_at` is set | **409**. Nothing created: `order_group` count unchanged, `order` count unchanged, commission-line count unchanged, `reserved_quantity` unchanged. Assert on **status only** — the framework rewrites a `CONFLICT` message. |
| **S2-B** *(layer 2, workflow — the gate that cannot be skipped)* | The workflow's `order_group` `useQueryGraphStep` selects **`id`** (the minimal repair is `fields: ["id", "cart_id"]`), so `orderGroupId` resolves to a real id on re-entry and the `when(…!orderGroupId)` branch is skipped. | Read the patch. **The route check alone, with the workflow untouched, is an automatic FAIL of S2 as a whole**, regardless of what the sequential test shows. |
| **S2-C** *(prove B independently of A)* | Invoke `completeCartWithSplitOrdersWorkflow` **directly** (container-level, bypassing the route) twice on one already-completed cart. | Exactly **1** `order_group` total; the second run returns the **existing** `order_group_id` via the `createdOrderGroup?.id ?? orderGroupId` transform at line 623-624. This is what isolates the workflow guard from the route guard — without it, S2-B is unverifiable. |
| **S2-D** *(true concurrent race — this is the definition the PO asked me to fix)* | 5 completes issued in parallel against **one fresh, never-completed** cart, fired from a single client with no sequencing between them (`Promise.all` over 5 requests, or 5 concurrent `curl`s started by one `&`-fanout), so that all 5 pass the route's `completed_at` read before any writes `completed_at`. | **All of the following, together:** (1) exactly **1** `order_group` row for that `cart_id`; (2) exactly **N** `order` rows, N = distinct sellers in the cart, and **no duplicates per seller**; (3) exactly **one** commission-line set (no line duplicated per order); (4) `reserved_quantity` for each inventory item incremented **once**, not 5×; (5) **one** payment collection, its amount equal to the cart total; (6) **no response is 5xx** — each of the 5 is either 200 carrying the *same* `order_group.id`, or 409. A run in which four requests 500 is a FAIL even if the DB ends up correct. |
| **S2-E** | The race must be shown to have actually raced. | The test must record, per request, that it was in flight concurrently — e.g. all 5 dispatched before any resolved. A "race" test that serialises via `await` in a loop proves S2-A over again and **not** S2-D, and will be rejected in pass 2. If the environment cannot demonstrably overlap the requests, say so explicitly and fall back to S2-C plus a documented `acquireLockStep` argument — do not silently pass off a sequential run as a race. |
| **S2-F** | Happy path | First complete on a fresh cart still returns 200 `{ type: "order_group", order_group: … }` with the created group and the query-config fields, unchanged. |
| **S2-G** | Payment-error path | The existing `PAYMENT_AUTHORIZATION_ERROR` / `PAYMENT_REQUIRES_MORE_ERROR` branch still returns **200** with `type: "cart"` and the error body. The new `completed_at` check must sit **before** the workflow call and must not intercept this path. |
| **S2-H** | Workflow graph body | No plain `if`/`for`/`while`/`await` added inside `createWorkflow`. The guard stays a `when().then()`. `orderGroupId` stays produced by `transform`. Reading `orderGroup.data.id` outside a `transform` is a FAIL. |
| **S2-I** | Lock and compensation intact | `acquireLockStep({ key: input.cart_id, … })` stays first; `releaseLockStep` stays outside the `when` branch (line 619) so a re-entrant call still releases; `idempotent: false` and `retentionTime` unchanged unless the dev justifies otherwise in the log. No step loses its compensation. |
| **S2-J** | Re-entry does not throw earlier than the guard | `validateCartPaymentsStep` (line 100) runs **before** the `when` branch, on every entry including re-entry. The dev must confirm — with a run, not an argument — that a re-entrant workflow invocation on a completed cart does not throw there. If it does, the 200-with-existing-group outcome in S2-C/S2-D(6) is unreachable and the design must change (e.g. move the payment validation inside the branch) **within this overlay**. This is the most likely way S2 half-lands. |

**Intended final semantics, stated so the dev does not invent a third:** route sees
`completed_at` → **409**; a racer that gets past the route hits the workflow guard → **200
with the pre-existing order group**. Both are correct; they are different layers, not a
contradiction.

**Regression surface — must NOT change:**
- Split-order creation itself: orders per seller, seller↔order links, order↔cart links,
  order_group↔order links, promotion links, seller↔customer link creation, the
  `orderGroupCreated` hook, `OrderWorkflowEvents.PLACED` and `OrderGroupWorkflowEvents.CREATED`.
- `updateCartsStep([updateCompletedAt])` still writes `completed_at` (line 434/546) inside
  the create branch. Do **not** move it outside the branch to make the route check fire
  earlier — that would mark carts complete that failed to produce orders.
- `refreshOrderCommissionLinesWorkflow.runAsStep` and `reserveInventoryStep` stay inside the branch.
- The `validate` hook's input shape (public extension point).

---

### S3 — P0.5 `GET /store/orders/:id` requires being the customer

**Overlay `007-store-order-detail-customer-scope.patch`**
**File:** `packages/core/src/api/store/orders/[id]/route.ts` (+ possibly a middleware
registration — see S3-B).

**[QC-AMENDS-PO] — the PO's one-line framing understates the work.** I checked the
middleware chain: `packages/core/src/api/store/orders/` has **no** Mercur `middlewares.ts`,
and `dist/api/store/orders/middlewares.js` is **not** in the `OVERRIDES` list of
`packages/core/src/utils/disable-medusa-middlewares.ts`, so Medusa's own array is live —
and in Medusa 2.20.1 that array registers `authenticate("customer", …)` on `/store/orders`
but **deliberately not** on `/store/orders/:id`. Medusa's own handler carries the comment
`// TODO: Do we want to apply some sort of authentication here?`. Consequence: on this
route `req.auth_context` is **undefined**, so "filter on `req.auth_context.actor_id`
exactly as the sibling list route does" throws a `TypeError` → **500**, not 401. The fix
must establish the auth context or handle its absence explicitly.

| ID | Gate | Expected |
|---|---|---|
| **S3-A** | Publishable key only, no customer JWT, a real order id | **401** (`MedusaError.Types.UNAUTHORIZED`). 404 is accepted as a fallback only if the dev documents why 401 was unreachable. **500 is a FAIL** — and a naive `req.auth_context.actor_id` dereference produces exactly that. |
| **S3-B** | Whichever mechanism is chosen, it is explicit | Either (i) register `authenticate("customer", ["session","bearer"])` for the `/store/orders/:id` matcher via a Mercur `store/orders/middlewares.ts` wired into `store/middlewares.ts` — note this is a **new file inside an overlay**, so G10 applies; or (ii) guard in the handler: `if (!req.auth_context?.actor_id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, …)`. Option (ii) is the smaller blast radius and is preferred. Whichever is used, the dev states the choice and why in `04-dev-log.md`. |
| **S3-C** | Customer A's JWT, customer B's order id | **404** (`NOT_FOUND`), not 403 — matches `ensure-seller-scope-middleware.ts` and `store/order-groups/[id]/route.ts`, and prevents id-probing. |
| **S3-D** | Customer A's JWT, A's own order | **200**, payload byte-identical to today's: same fields, `withCartPaymentCollectionFields(req.queryConfig.fields)` still applied, `normalizeOrderPaymentCollections(result)` still called. |
| **S3-E** | The scope filter is server-derived | `customer_id` comes from `req.auth_context.actor_id` and **never** from query, body, or `req.filterableFields`. A client-supplied `customer_id` in the query string must not widen the result. Add an explicit test for `?customer_id=<B's id>`. |
| **S3-F** | `is_draft_order: false` still passed | Draft orders must stay invisible on the store surface. Adding `customer_id` must not replace it. |
| **S3-G** | **Do not break token-based guest transfer.** If option (i) is chosen, the added matcher must be **`/store/orders/:id` exactly** — Medusa intentionally leaves `POST /store/orders/:id/transfer/accept` and `/transfer/decline` unauthenticated (token-bearing). A wildcard `/store/orders/*` or `/store/orders/:id/*` authenticate is a **FAIL**. | Verified against Medusa's `storeOrderRoutesMiddlewares`. |
| **S3-H** | No duplicate query validation | If option (i) is chosen, Medusa's entry for `/store/orders/:id` still runs `validateAndTransformQuery(StoreGetOrderParams, retrieveTransformQueryConfig)`. The Mercur entry must **not** re-register it — double transformation of `req.queryConfig` is a silent field-set corruption. |

**Test (G7):** adversarial spec under `integration-tests/http/order/store/`. Red today on
S3-A (currently 200 with PII).

**Regression surface — must NOT change:**
- `GET /store/orders` (list) — already correct, do not touch.
- `GET /store/order-groups/:id` — already correct, do not touch.
- `POST /store/orders/:id/transfer/{request,cancel,accept,decline}` — all four keep their
  current auth behaviour (S3-G).
- The split-order payment-collection normalisation utilities in
  `packages/core/src/api/store/utils/split-order-payment-status.ts`.
- Storefront order-confirmation and order-history pages must still load for a logged-in
  customer. If the storefront fetches an order detail **without** a customer token
  anywhere (e.g. a post-checkout confirmation page relying on the guest path), that call
  now 401s — the dev must grep `apps/storefront` for order-detail fetches and report the
  result **before** the fix is accepted. This is the single most likely user-visible
  regression in the cycle.

---

### S4 — P0.4 Inventory items belong to the seller that created the offer

Two deliverables, **two independent gate sets**. Neither substitutes for the other.

#### S4-CODE — **Overlay `008-offer-inventory-seller-link.patch`**
**File:** `packages/core/src/workflows/offer/workflows/create-offers.ts` (lines 122-129), and
`packages/core/src/workflows/inventory-item/steps/link-seller-inventory-item.ts` if the
step's input shape changes.

The defect, re-read at source:

```ts
const sellerId = transform({ input }, ({ input }) => input.offers[0]?.seller_id ?? "")
linkSellerInventoryItemStep({ seller_id: sellerId, inventory_item_ids: createdInventoryItemIds })
```

The correct mapping is already computed in the same file: `offerSpans` (line 83/101,
`{ start, length }` per offer, already consumed at line 242) indexes `createdInventoryItems`
back to `input.offers[i]`. Use it. Do not invent a second mapping.

| ID | Gate | Expected |
|---|---|---|
| **S4-C1** | `createOffersWorkflow` run with a batch spanning **two sellers** links each created inventory item to the seller of the offer that **declared** it. | An integration test asserting exactly this, per item, for a ≥2-seller batch. No current test creates a multi-seller batch — this test is new and is the point of S4-CODE. |
| **S4-C2** | The `?? ""` fallback is gone. An offer with no resolvable `seller_id`, or an empty batch, must **not** create a link to seller `""`. | Test: empty `offers` array → zero link rows created (or the workflow rejects); no row with `seller_id = ''` anywhere. |
| **S4-C3** | Workflow graph body | The per-offer mapping is built in a **`transform`**. No `for`/`if`/`await` in the `createWorkflow` body; no reading `createdInventoryItems.<field>` outside a `transform`; no calling `linkSellerInventoryItemStep` in a loop. |
| **S4-C4** | Compensation still exact | `linkSellerInventoryItemStep`'s compensation (3rd arg to `createStep`) must dismiss **precisely the links it created**. If the input shape changes from `{ seller_id, inventory_item_ids }` to pairs, the compensation input and the `remoteLink.dismiss` payload change with it. A compensation that dismisses `(offers[0].seller_id, all ids)` after creating per-seller links is a **FAIL** — it leaves orphan rows on rollback. Prove it: run the workflow with a downstream step forced to throw and assert **zero** `inventory_item_seller` rows remain. |
| **S4-C5** | Second caller unbroken | `packages/core/src/workflows/inventory-item/workflows/create-seller-inventory-items.ts:30` also calls this step with a single `seller_id`. If the signature changes, that caller is updated **in the same overlay** (same concern) and its behaviour is unchanged. If the signature does not change, say how the per-offer mapping is expressed instead. |
| **S4-C6** | Module isolation | Links are still written through the step's `remoteLink` inside a workflow. No direct service reach-across, no raw SQL. |
| **S4-C7** | Single-seller batches unchanged | The three production callers (`vendor/offers/route.ts`, `vendor/offers/batch/route.ts`, `admin/offers/batch/route.ts`) all stamp one `seller_id`. Their observable behaviour — link rows created, offer rows created, stock levels — must be byte-identical before and after. Prove with the existing `http/offer` and `http/inventory` suites. |

#### S4-DATA — **new file, direct add** (e.g. `apps/api/src/scripts/repair-inventory-seller-links.ts`)

Adding a new file is always allowed; this is not an overlay. It is a Medusa custom CLI
script (`ExecArgs` default export, run via `medusa exec`).

| ID | Gate | Expected |
|---|---|---|
| **S4-D1** | Correctness | After the repair, `inventory_inventory_item_seller_seller` matches offer-derived ownership. Target distribution from the PO's live count: **240 / 237 / 226 / 222 / 219** across the five sellers, total 1144. Ownership is derived as `inventory_item → offer_inventory_item → offer.seller_id`; the PO verified this relation is 1:1 over all 1144 rows with **zero** items resolving to more than one seller. |
| **S4-D2** | **Ambiguity is fatal, not fudged** | If the script encounters an inventory item resolving to 0 or >1 sellers, it must **abort the whole run and write nothing** (or skip it and report it explicitly by id). Silently picking one is a FAIL. |
| **S4-D3** | **Idempotent** | Running the script **twice in a row** produces the identical final row set and the second run reports **0 changes**. Prove with a row count + a checksum of `(inventory_item_id, seller_id)` pairs before/after run 2. |
| **S4-D4** | **Reversible** | Before writing, the script captures the pre-repair `(inventory_item_id, seller_id)` set to a file (JSON, path printed). A documented, tested procedure restores it. Prove the round trip: snapshot → repair → restore → the pair set equals the original snapshot exactly. |
| **S4-D5** | **Dry-run first** | The script supports a dry-run (default dry-run, or an explicit `--apply`) that reports the exact number of rows it would delete and create, per seller, and writes nothing. A repair script that only has an apply mode is a FAIL. |
| **S4-D6** | Writes go through the framework | Link rows are written with the remote link / a workflow, not raw SQL against `inventory_inventory_item_seller_seller`. Module isolation applies to scripts too. |
| **S4-D7** | The script is not a substitute for S4-CODE, and says so | A header comment stating that without overlay `008` the data regresses on the next mixed batch. |

#### S4-EFFECT — the boundary actually holds

| ID | Gate | Expected |
|---|---|---|
| **S4-E1** | Seller B → `GET /vendor/inventory-items/{A's item id}` → **404** (via `validateSellerInventoryItem`, `packages/core/src/api/vendor/inventory-items/helpers.ts:25`). |
| **S4-E2** | Seller A → `GET /vendor/inventory-items/{A's own item id}` → **200**, and A can list/update their own stock. This is the half that is broken **today** for 4 of 5 sellers. |
| **S4-E3** | Seller B → `POST /vendor/inventory-items/{A's id}/location-levels/batch` → 404. The §0 exploit (setting a rival's `stocked_quantity` from 1,000,000 to 0) must be dead. |
| **S4-E4** | `validateSellerInventoryItem` and the vendor inventory-items routes are **not modified**. The PO is right: the API check is correct; the link data and the workflow were wrong. A patch touching those routes is a G3 FAIL. |

**Regression surface — must NOT change:** offer creation (row counts, prices, stock levels,
`offer_inventory_item` rows); `createInventoryItemsWorkflow` usage; the `offerSpans`
consumer at line 242; reservation behaviour at checkout (`prepareOfferInventoryInput`).

---

### S5 — P0.3 Vendor product routes assert ownership

**Overlay `009-vendor-product-ownership.patch`**
**Files:** `packages/core/src/api/vendor/products/middlewares.ts` (primary), and
`[id]/route.ts` / `[id]/cancel/route.ts` only if a handler-level call is unavoidable.

Reuse `ensureSellerOwnsProduct(scope, sellerId, productIds)` from
`packages/core/src/api/vendor/products/helpers.ts:60` — already used by
`vendor/product-categories/[id]/products/route.ts`. **Do not write a second helper.**
Its semantics are deliberate: a seller owns a product it is *assigned* (`product_seller`)
**or** *authored* (a `PRODUCT_ADD` `product_change_action` it created). Do not narrow it to
authorship — that breaks legitimate resellers of the shared master catalog.

Ordering is safe: `/vendor/*` at `vendor/middlewares.ts:88-101` runs
`authenticate` + `ensureSellerMiddleware` and is registered **before** `vendorProductsMiddlewares`,
so `req.seller_context.seller_id` is populated when a per-route middleware runs.

| ID | Gate | Expected |
|---|---|---|
| **S5-A** | Seller B → `POST /vendor/products/{A's id}` | **404**. No `product_change` row created, `product_change_action` count unchanged, product title unchanged. |
| **S5-B** | Seller B → `DELETE /vendor/products/{A's id}` | **404**. Today this matcher has `middlewares: []` — literally zero middleware. |
| **S5-C** | Seller B → `POST /vendor/products/{A's id}/cancel` | **404**. |
| **S5-D** | **[QC-AMENDS-PO]** Seller B → `GET /vendor/products/{A's id}` | The gate is **not** "always 404 for another seller's product". `applySellerProductLinkFilter` (`middlewares.ts:38-65`) deliberately lets a seller see `PUBLISHED` products not restricted to other sellers — that is the shared master catalog they build offers against. Applying `ensureSellerOwnsProduct` to GET would 404 the whole catalog and break offer creation. **The correct gate: `GET /vendor/products/:id` must return exactly what `GET /vendor/products` would show for the same seller.** A product **absent from B's list** must 404 on B's detail read; a product **present in B's list** must 200. The §0 exploit — B reading A's **draft** product — is covered, because a draft is neither B's nor `PUBLISHED`. If the dev cannot reconcile this, escalate to the PO rather than choosing. |
| **S5-E** | Seller A on A's own product | `GET` 200, `POST` 202, `DELETE` 202, `cancel` 200 — all unchanged from today, including response shapes (`{ product_change }`, status 202 on POST/DELETE). |
| **S5-F** | **Independent of `rbac`** | Enforcement holds with `featureFlags.rbac = false` — this instance's actual state (`packages/core/src/with-mercur.ts:53` defaults it off; `ensure-seller-middleware.ts:67-69` early-returns before role resolution when off, so **every `policies: [...]` in the codebase is inert**). The ownership check must be an always-on middleware/handler call. **A fix that adds, changes, or relies on a `policies:` entry is an automatic FAIL.** Prove it: the S5-A..D tests run against the default config with rbac off, and the dev states that no code path in the fix consults `FeatureFlag`. |
| **S5-G** | Fail closed, `NOT_FOUND` | Rejection is `MedusaError.Types.NOT_FOUND` → 404, never 403, so the route cannot enumerate product or seller ids. The whole request is rejected — no silent filtering to an empty result on a write route. |
| **S5-H** | Existing policy declarations preserved | The `policies: [...]` blocks stay exactly as they are (they are the RBAC layer and become meaningful when the flag is on). Removing them is a G3/G9 FAIL. |
| **S5-I** | Matcher coverage is stated, not accidental | Medusa matchers are path-exact: a middleware on `/vendor/products/:id` does **not** cover `/vendor/products/:id/cancel`, `/variants`, `/variants/:variant_id`, or `/attributes/batch`. The dev must state in `04-dev-log.md` which matchers the ownership middleware is registered for and, for each `:id` sub-route **not** covered, whether it is already scoped or is a known remaining hole (a cycle-2 item). Extending coverage to the sub-routes is **permitted and welcome** but then S5-J applies. |
| **S5-J** | No regression from widened coverage | If the middleware is registered on a wildcard covering `:id` sub-routes, the existing variant/attribute suites must still be green (`http/product`, `http/product-edit`, `http/product-attribute`), and offer creation against shared-catalog products must still work. |
| **S5-K** | Validator pairing intact | `POST /vendor/products/:id` still gets `validateAndTransformBody(VendorUpdateProduct)` and `POST /vendor/products/:id/cancel` still gets `validateAndTransformBody(VendorCancelProductChange)` — both handlers read `req.validatedBody`. Adding an ownership middleware must not displace or reorder them into a position where `req.validatedBody` is unavailable. Ownership should run **after** validation (it needs only `req.params.id`), and `DELETE`'s currently-empty `middlewares: []` becomes `[ownership]`, not `[]` plus a handler call. |
| **S5-L** | No client-supplied scope | Seller id comes from `req.seller_context.seller_id` only. A `seller_id` in body/query must be ignored; add a test that sending `seller_id: <A's id>` as B does not widen access. |

**Test (G7):** adversarial spec under `integration-tests/http/product/vendor/`, two sellers,
covering S5-A..E, S5-F and S5-L. Red today on A, B, C and the draft case of D.

**Regression surface — must NOT change:**
- `GET /vendor/products` list filtering (`applySellerProductLinkFilter` + `applyOfferedProductsFilter`)
  — the visibility predicate S5-D must **match**, so if the dev changes one they change both,
  and that is scope creep: prefer reusing the existing helpers unchanged.
- `POST /vendor/products` (create) — no ownership check applies to a product that does not exist yet.
- The product-change / admin approval flow: `productEditUpdateProductWorkflow`,
  `productEditDeleteProductWorkflow`, `cancelProductChangeWorkflow`, the 202 statuses,
  and the admin queue's view of legitimate changes.
- `ensureSellerOwnsProduct`'s assigned-**or**-authored semantics and its current caller in
  `vendor/product-categories/[id]/products/route.ts`.
- `getSellerOwnedProductIds` / `getProductIdsRestrictedFromSeller`.

---

## Part C — QC findings the dev must resolve before pass 2

Raised now so they are not discovered at review time. Each needs an answer in `04-dev-log.md`.

1. **S3 has no auth middleware to lean on.** Medusa 2.20.1 leaves `/store/orders/:id`
   unauthenticated by design (its own `TODO` comment). `req.auth_context` is undefined
   there. The "copy the sibling route" instruction does not work verbatim — see S3-B.
2. **S3 storefront risk.** Grep `apps/storefront` for order-detail fetches lacking a
   customer token *before* accepting the fix. Report the result.
3. **S5-D collides with the shared master catalog.** The PO's literal "GET → 404" would
   404 the published catalog and break offer creation. Gate S5-D restates it as
   list/detail consistency. Escalate rather than choose differently.
4. **S2-J: `validateCartPaymentsStep` runs before the guard** on every entry. If it throws
   on re-entry, the intended 200-with-existing-group is unreachable. Test it early.
5. **S4-C4/C5: the link step is shared.** `linkSellerInventoryItemStep` has a second caller
   and a compensation keyed to the old single-seller shape. Changing the input shape
   without changing both is the likeliest way S4 ships broken.
6. **G10: an overlay that creates a file needs `git add -N`.** `git diff` omits untracked
   files, so the patch would ship an import with no target and the image build would break
   only at runtime. Relevant if S3 takes option (i).
7. **`?? ""` is a second latent bug (S4-C2).** Fix it in the same patch — it is the same concern.

## Part D — Explicitly out of scope for these gates

Do not let a fix quietly absorb: P0.6's `?limit` cap and `order` validation (beyond the
`unit_price: -100` case S1-C closes for free), P1.1/P1.2/P1.3, P1.4's route-walking guard,
P2.1/P2.2/P2.3 money and transaction work, P2.4 commission specificity (blocked on the
human), P3.1 seller visibility, and P5.1's 162 `any`. Any of these appearing in an overlay
is a **G3 FAIL** even if the change is correct.

`.claude/skills/mercur/SKILL.md` (P5.2) is a direct edit and outside the overlays — the PO
allows it as end-of-cycle slack. It is **not** a gate and must not be bundled into any patch.

## Part E — Pass-2 review checklist (what I will run)

1. Revert overlays → `git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"` empty (G1).
2. `./deploy/overlays/apply.sh --check` → `005`–`009` all `pending`; apply → all `applied`; `--revert` → pristine (G4).
3. Read each patch hunk by hunk against G3/G6/G9 and the item's regression surface.
4. Re-run each item's adversarial spec **both** ways myself — reverted (red) and applied (green) — foreground, with a path relative to `integration-tests/`, and check the reported test count is non-zero (G7, S0-B).
5. `bun run build` (12/12) and `bun run lint` (G5) on the applied tree.
6. Run the surface suites for regressions (G8).
7. Verdict per item PASS/FAIL/PARTIAL with `file:line` evidence → appended to
   `fix-cycle/04-dev-log.md`, plus `fix-cycle/05-qc-verdict.md` with an explicit
   **ship / do not ship**.

I do not accept a self-report in place of output, and I do not soften a FAIL.
