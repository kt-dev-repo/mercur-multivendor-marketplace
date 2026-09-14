# Fix cycle 1 — closure record

Consolidates the five stage handoffs (`01`–`05`) plus live verification.
Full narrative is in git history at `791aeb1ee`; this file is the durable record.

- **Opened** 2026-09-10 · **Closed** 2026-09-14
- **Upstream base** `a925daf62` · **Medusa** 2.20.1
- **Outcome** SHIP — 5 of 5 scheduled defects fixed, verified, and exercised live.

Stages: PO work order → QC gates → tester reproductions → dev implementation →
QC review → live verification. Artefacts are overlays `005`–`009`, one data-repair
script, and five adversarial specs.

---

## Result per item

| # | Defect | Overlay | QC verdict | Live |
|---|---|---|---|---|
| S1 | Price tampering via `unit_price` on the public store route | `005` | PASS | confirmed |
| S2 | Duplicate orders — guard queried a field it never selected | `006` | PASS | confirmed |
| S3 | `GET /store/orders/:id` leaked customer PII | `007` | PASS-COND | confirmed |
| S4 | Every inventory item linked to `offers[0].seller_id` | `008` + script | PASS | data verified |
| S5 | `/vendor/products/:id` had no tenant boundary | `009` | PASS-COND | confirmed |

**Test evidence.** Reproductions 15 failed → **25/25 passed**. Regression 295
passed / 0 failed (QC's run; the dev's wider sweep was 899 passed / 0 failed
across 95 suites). Build 12/12, unit 13/13, lint clean. All re-run independently
by QC rather than taken from the developer log.

---

## Live verification (2026-09-14)

Full stack under Podman — API :9000, storefront :3000, admin :7001, vendor :7002,
Postgres + Redis in containers. **`MEDUSA_FF_RBAC=false`**, which is what
discharges QC ship-condition C1: the patched guards had never executed with
route policies inert.

| Probe | Before | After |
|---|---|---|
| Honest add, qty 5 | 220 EUR | 220 EUR |
| `unit_price: 1` | real 5 EUR order | **400** unrecognized field |
| `compare_at_unit_price` | accepted | **400** |
| `unit_price: -100` | 500 | **400** (clean) |
| `GET /store/orders/:id`, key only | 200 + email/name/address | **401** |
| `transfer/accept` (must stay open) | 400 | **400** — not over-broadened |
| Complete same cart twice | 2 groups / 2 orders | 200 then **409**, 1 group |
| 5 concurrent completes | — | all 200, **same** group id, 1 group |
| B reads A's draft / POST / DELETE | 200 / 200 / 200 | **404 / 404 / 404** |
| B reads shared published product | 200 | **200** — offers still work |
| Inventory→seller spread | 1144 on one seller | **240/237/226/222/219**, 0 empty |

Zero API errors across the whole run. Storefront rendered 410 KB with products;
both dashboards returned 200.

---

## Open items — deliberately not closed

1. **P0.3 is NOT closed.** Overlay `009` covers GET/POST/DELETE/cancel on
   `/vendor/products/:id`. Four sub-route matchers still assert no ownership —
   `variants/route.ts:38`, `variants/[variant_id]/route.ts:43,79`,
   `attributes/batch/route.ts:15` — they use `seller_id` only as `created_by`.
   **Reproduced live:** seller B queued a `VARIANT_ADD` `product_change` against
   seller A's product with `created_by` = B.
   Bounded by default (`product_request` defaults `true`, so it lands `pending`
   for operator review), but `auto-confirm-product-change.ts:30` auto-confirms
   every change when that flag is off — so an operator setting
   `MEDUSA_FF_PRODUCT_REQUEST=false` converts this into an immediate
   cross-tenant write. Must be named in the upstream disclosure.

2. **`OrderGroupRepository.findAndCount` silently drops unknown filters.**
   Overlay `006` adds `cart_id`, but the hand-rolled `WHERE` builder still
   ignores any key outside its allow-list, returning the whole table. A dropped
   filter that returns *more* rows is a broken-access-control primitive. Rank
   this high next cycle — same class as P0.5.

3. **P2.4 commission specificity** — still blocked on a human ruling. Code scores
   dimension-count; docs describe per-reference weight. Either answer changes
   seller payouts and needs a second ruling on recomputing existing lines.

4. **`apps/api` has no build/typecheck task**, so nothing under `apps/api/src` is
   covered by `bun run build`. Three scripts fail `tsc --noEmit`.

---

## Rulings worth keeping

- **Ownership must never share a kill switch with RBAC.** `with-mercur.ts:53`
  defaults `rbac` to `false`, so every `policies:[...]` on every vendor and admin
  route is decorative on a default install. This is the single most valuable
  thing to send upstream.
- **QC's own gate S2-B was wrong.** Its "minimal repair" would have made the
  guard match the newest order group in the store and silently skip order
  creation for every cart after the first — worse than the duplicate-order bug.
  The repository fix in `006` is required, not optional.
- **Do not naively 404 non-owned products.** `applySellerProductLinkFilter`
  deliberately exposes the published master catalogue so sellers can build offers
  against it. The correct gate is list/detail consistency, which `009` implements.
- **The data repair is a soft delete.** `link.dismiss` tombstones rather than
  removes, so the raw table holds 2062 rows (918 tombstones); `dismiss` + `create`
  are not atomic. Retain both snapshots in `apps/api/.medusa/`; never restore
  across databases.
- **414 pre-existing integration tests caught none of these five defects.**

## Disclosure

These are upstream Mercur/Medusa defects. Report privately to mercurjs before any
public write-up or before publishing an overlay whose diff reveals the exploit.
The S3 PII leak is Medusa's, not Mercur's — `/store/orders/:id` ships with the
verbatim comment `// TODO: Do we want to apply some sort of authentication here?`
