# Overlays

Fixes to **upstream-tracked files** that this repository deliberately does not
commit.

## Why

`main` is a byte-identical mirror of `mercurjs/mercur`. Nothing upstream owns is
ever modified in a commit, so the diff against our upstream base shows only added
files and `git merge upstream/main` can never conflict — upstream releases can be
pulled in forever at zero cost.

```bash
# Verify the invariant. Compare against the upstream commit we are BASED on,
# not upstream/main — once upstream advances, its tip differs from our base and
# a plain `git diff upstream/main` reports upstream's own changes as if they
# were ours.
git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"
# empty output = no upstream-tracked file was modified
```

That guarantee would be lost the moment a fix edited an upstream file. So fixes
live here as patches and are applied **on a copy**: inside the container image at
build time, or temporarily in a local checkout while developing.

Mercur uses the same idea internally — `packages/core/src/patches/` patches
`@medusajs/core-flows` rather than forking it.

## Usage

```bash
./deploy/overlays/apply.sh            # apply every overlay
./deploy/overlays/apply.sh --check    # report status, change nothing
./deploy/overlays/apply.sh --revert   # restore the pristine upstream files
./deploy/overlays/apply.sh --only 001 # act on one overlay by prefix
```

Applying is idempotent. `git status` will show modified upstream files while
overlays are applied — that is expected; `--revert` returns the tree to pristine.
**Never commit an overlaid file.**

The three Dokploy images run `apply.sh` during their build, so deployments get
these fixes without the repository ever carrying them.

## States

| State | Meaning |
|---|---|
| `pending` | applies cleanly, not yet applied |
| `applied` | already in the tree |
| `skipped` | none of the patch's target files exist here — images copy only part of the tree, so the docs overlay is skipped in them |
| `conflict` | targets exist but the patch will not apply — **upstream changed underneath it**; regenerate the patch, do not force it |

A conflict fails the script (and therefore the image build) on purpose. A
half-applied overlay is worse than none.

## The overlays

### `001-storefront-not-found-status.patch`

Unknown product, seller and collection handles returned **HTTP 200** instead of
404. `ProductDetailsPage` did `if (!prod) return null`, so the page rendered
chrome with no content and no `<title>`; the seller page did the same; the
collection page rendered the not-found component but left the status at 200, as
did the suspended-seller branch. These are soft 404s — search engines index the
empty pages. Uses `notFound()` from `next/navigation` in all four places, which
is what `categories/[category]` already did.

Verified in the production image: unknown product/seller/collection → 404, while
`/de`, an existing product and an existing seller still return 200.

### `002-jest-swc-transform-resolution.patch`

`bun run test:unit` failed before running a single test with
`Module @swc/jest in the transform option was not found`. The unit run sets
`rootDir` to the repo root to reach specs in the workspace packages, and Jest
resolves transforms relative to `rootDir` — but `@swc/jest` is a devDependency of
`integration-tests` and is not hoisted there. Resolves both transforms with
`require.resolve`, from the config file rather than from `rootDir`.

Verified: unit run 13 passed / 3 suites; the HTTP suites share the block and are
unaffected.

### `003-dashboard-ports-docs.patch`

`CLAUDE.md` and `docs/ARCHITECTURE.md` documented admin on 7000 and vendor on
7001. Those are the `preview` ports; the `dev` scripts bind **7001** and **7002**
— the values that must appear in `ADMIN_CORS` / `VENDOR_CORS`. Also replaces the
fixed worktree URLs with `./scripts/dev-worktree.sh <name> ports`, since that
script assigns a free port per worktree.

Docs only. Skipped inside images, which do not copy `docs/` or `CLAUDE.md`.

### `004-s3-file-provider-switch.patch`

`apps/api/medusa-config.ts` hardcoded Medusa's **local** file provider. That
writes to the container filesystem, bakes its origin into every stored file URL,
cannot be shared across API replicas, and breaks when the public origin changes.

Makes the provider a switch driven by env: **`S3_BUCKET` set → S3, otherwise
local**, so local development is unchanged and production opts in without a code
change. Resolve string is `@medusajs/medusa/file-s3` — note `@medusajs/file-s3`
is NOT resolvable from `apps/api` under bun's isolated layout, only the path
re-exported through `@medusajs/medusa`.

Handles the awkward parts of real S3-compatible services:

| Variable | Why it exists |
|---|---|
| `S3_ENDPOINT` | required by everything that is not real AWS |
| `S3_FORCE_PATH_STYLE` | MinIO and other path-style services |
| `S3_ACL=false` | buckets that reject ACL headers — AWS Object Ownership `BucketOwnerEnforced` (default since 2023) and Cloudflare R2 |
| `S3_AUTHENTICATION_METHOD=s3-iam-role` | instance roles / IRSA, with both keys omitted |
| `S3_ADDITIONAL_CLIENT_CONFIG` | raw JSON escape hatch into the S3 client |

Verified against MinIO: with `S3_BUCKET` set the API booted clean, `/admin/uploads`
returned an `S3_FILE_URL`-based URL, the object appeared in the bucket, and
fetching that URL returned the exact bytes. Removing `S3_BUCKET` reverted to
`http://localhost:9000/static/...` and local uploads still served correctly — the
switch works in both directions with no code change.

### `005-store-line-item-no-client-price.patch`

**Symptom.** `POST /store/carts/:id/line-items` — a public route, reachable with
only the publishable key — accepted `unit_price` and `compare_at_unit_price` and
honoured them. 220 EUR of goods went into a cart for 5 EUR, the order completed,
and the payment collection was written for the tampered total. `unit_price: -100`
produced a 500 from a database check constraint.

**Cause.** `StoreAddCartLineItem` declared both fields, and
`api/store/carts/[id]/line-items/route.ts` destructures only
`{ additional_data, metadata, offer_id, ...item }`, spreading `...item` — prices
included — straight into `addToCartWorkflow`.

**Fix.** Delete the two fields. The schema is already `.strict()`, so they are now
rejected as unrecognized keys with a clean 400, and the price resolves server-side
from the offer. Medusa's own store API never exposed them; the storefront posts
only `{ offer_id, quantity }`, and no test sends them.

**Behaviour change.** A third-party client sending either field now gets 400.
That is the intent.

**Evidence.** `integration-tests/http/offer/store/store-line-item-price-tampering.local.spec.ts`
— 4 failed / 1 passed before, 5 passed after; the normal add still resolves 4400
per unit and a total of 22000.

### `006-cart-complete-idempotency.patch`

**Symptom.** One cart produced many order groups. Two *sequential* completes — a
refreshed confirmation page — created a second order group, a second set of
orders and a second set of commission lines against a single payment. Five
concurrent completes produced 5 groups, 10 orders and stock reserved 5×.

**Cause.** Three layers, all needed:

1. `OrderGroupRepository.findAndCount` is a raw-SQL override that recognises only
   `id`, `customer_id`, `seller_id`, `status`, `sales_channel_id`, `created_at`,
   `updated_at` and `q`. A `cart_id` filter was **silently dropped**, so a
   by-cart lookup returned the entire table.
2. `complete-cart-with-split-orders.ts` looked the group up with
   `fields: ["cart_id"]`, so `orderGroup?.data?.id` was `undefined` on every
   entry and `when(…!orderGroupId)` always took the create branch.
3. The route ran the workflow unconditionally, even on a cart already stamped
   `completed_at`.

**Fix.** Teach the repository about `cart_id`; select `id` in the workflow's
lookup so the existing guard can fire; 409 at the route when `completed_at` is
already set. Fixing (2) without (1) is *worse than the bug* — the guard would
then match the newest order group in the store and silently skip order creation
for every later cart. `http/order/admin/order-list-filters.spec.ts` catches
exactly that.

**Semantics.** Route sees `completed_at` → **409**. A racer that gets past the
route hits the workflow guard → **200 with the pre-existing order group**.

**Evidence.** `integration-tests/http/offer/store/cart-complete-idempotency.local.spec.ts`
— sequential #2 → 409, 5-way `Promise.all` race → exactly 1 group, 1 order per
seller, no duplicated commission line, each item reserved once, one payment
collection, no 5xx; two different carts still get two different groups; a direct
double invocation of the workflow returns the same `order_group_id` twice
(which also proves `validateCartPaymentsStep` does not throw on re-entry).

### `007-store-order-detail-customer-scope.patch`

**Symptom.** `GET /store/orders/:id` returned customer email, full name, street,
city, postcode and order total to anyone holding the public publishable key. The
sibling list route `GET /store/orders` correctly 401s.

**Cause.** The handler passed only `filters: { is_draft_order: false }` and never
`customer_id`. Worse, Medusa 2.20.1 deliberately registers **no** `authenticate`
for this matcher (its own handler carries `// TODO: Do we want to apply some sort
of authentication here?`), so `req.auth_context` was undefined and a
handler-only guard would have rejected legitimate customers too.

**Fix.** A Mercur `store/orders/middlewares.ts` registers
`authenticate("customer", ["session", "bearer"])` for **`/store/orders/:id`
exactly** — not a wildcard, because `/transfer/accept` and `/transfer/decline`
are intentionally token-bearing and unauthenticated — and the handler filters on
`req.auth_context.actor_id`. Query validation is left to Medusa's own entry for
the matcher; registering it twice would transform `req.queryConfig` twice.

**Evidence.** `integration-tests/http/order/store/order-detail-pii-leak.local.spec.ts`
— publishable key only → 401, another customer's order → 404, own order → 200
unchanged, `?customer_id=` in the query string still rejected by the strict
validator.

### `008-offer-inventory-seller-link.patch`

**Symptom.** Four of five sellers could not manage their own stock, and the fifth
could read and zero every rival's. 1144 of 1144 `inventory_item ↔ seller` rows
pointed at one seller who owns 226 offers.

**Cause.** `createOffersWorkflow` linked **every** inventory item in a batch to
`input.offers[0]?.seller_id ?? ""`. The three HTTP callers happen to stamp a
single seller, so the bug is latent there; the seeder is the one caller that
passes a mixed batch. The `?? ""` was a second latent bug: an unresolvable seller
became a link to seller `""`.

**Fix.** Build `(seller_id, inventory_item_id)` pairs in a `transform`, using the
`offerSpans` mapping the file already computes, and hand them to
`linkSellerInventoryItemStep`. The step now takes pairs instead of one
`seller_id`, so its compensation dismisses exactly the rows it created — which a
single seller id could not express for a mixed batch. Its second caller,
`createSellerInventoryItemsWorkflow`, is updated in the same patch and keeps its
behaviour. A missing `seller_id` throws instead of linking to `""`.

**Data.** The 1144 mislinked rows are repaired separately by
`apps/api/src/scripts/repair-inventory-seller-links.ts` (dry-run by default,
idempotent, reversible, aborts on ambiguity). The script is not a substitute for
this patch: without it the data regresses on the next mixed batch.

**Evidence.** `integration-tests/http/offer/vendor/offer-inventory-seller-link.local.spec.ts`
— a 2-seller batch links each item to its own offer's seller; an empty
`seller_id` is refused and no `seller_id = ''` row exists; a failure after the
link step leaves zero orphan rows; the single-seller caller is unchanged.
`http/inventory` and `http/offer` stay green.

### `009-vendor-product-ownership.patch`

**Symptom.** Any vendor could read, edit, cancel and delete any other vendor's
product. Seller B's edit to seller A's product reached the admin approval queue
as legitimate and, on confirm, renamed the product — and A could not cancel it.
B could also read A's unpublished draft.

**Cause.** `GET /vendor/products/:id` had only query validation, `POST` only
body + query, `DELETE` literally `middlewares: []`. The only tenant boundary was
`policies: [...]`, and `featureFlags.rbac` defaults to **false**
(`with-mercur.ts:53`), which makes `ensureSellerMiddleware` early-return before
role resolution — so **every** `policies:` declaration in the codebase is inert
on a default install.

**Fix.** Ownership is a tenant boundary, not a permission, so it must not share
RBAC's kill switch: `POST`, `DELETE` and `/cancel` get an always-on middleware
over the existing `ensureSellerOwnsProduct` helper, failing closed with
`NOT_FOUND`. No feature flag is consulted; the `policies:` blocks are left
untouched as the RBAC layer.

`GET` is deliberately different. `applySellerProductLinkFilter` exposes the
shared master catalogue (published products not restricted to another seller) so
sellers can build offers against it — a blanket 404 would break offer creation.
The visibility predicate is extracted once and used by both the list filter and a
detail-read guard, so **detail shows exactly what the list shows**: another
seller's *draft* 404s, a published catalogue product still 200s.

**Matchers covered:** `GET`, `POST`, `DELETE /vendor/products/:id` and
`POST /vendor/products/:id/cancel`. Medusa matchers are path-exact, so
`:id/variants`, `:id/variants/:variant_id` and `:id/attributes/batch` are **not**
covered by this patch — see `fix-cycle/04-dev-log.md` for their current state.

**Evidence.** `integration-tests/http/product/vendor/product-ownership.local.spec.ts`
— B → A's draft GET/POST/DELETE/cancel all 404, B → A's published product still
200 and present in B's list, A unchanged on its own product, a body `seller_id`
does not widen access. `http/product`, `http/product-edit` and
`http/product-attribute` stay green.

## Adding an overlay

1. Edit the upstream file in a checkout and verify the change works.
2. `git diff <the file> > deploy/overlays/00N-short-name.patch`
3. `git checkout -- <the file>` to restore pristine.
4. `./deploy/overlays/apply.sh --check` — the new patch should read `pending`.
5. Commit only the `.patch` file.

## Retiring one

When upstream fixes the same thing, `apply.sh` reports `conflict` (or the patch
becomes a no-op). Delete the `.patch` file.
