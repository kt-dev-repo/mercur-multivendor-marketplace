---
name: medusa
description: Apply Medusa 2.x framework conventions — modules, workflows, links, API routes, migrations, and the test runner. Use when writing or reviewing backend code under packages/core or apps/api.
---

# Medusa 2.x Conventions

Use this skill when:
- adding or changing a module, model, service, workflow, step, link, subscriber, or scheduled job in `packages/core`
- adding or changing an HTTP route under `packages/core/src/api/{admin,vendor,store}`
- writing migrations, or debugging why a schema change did not apply
- writing integration tests with `medusaIntegrationTestRunner`

This repo pins **Medusa 2.20.1** across every workspace via root `package.json` `overrides`. Never install a different `@medusajs/*` version in one workspace — the override is what keeps a single framework instance in the dependency graph, and a second copy breaks DI container resolution at runtime.

## Hard Rules

1. **Modules are isolated.** A module service must never import or resolve another module's service. Cross-module reads go through **links** + Query; cross-module writes go through **workflows**. If you feel the need to reach sideways, you are in the wrong layer.
2. **Business logic lives in workflows, not routes.** An HTTP route validates input, resolves scope, calls a workflow, and shapes the response. Nothing else.
3. **Every step that writes must compensate.** A step without a compensation function makes the workflow non-atomic. Return `StepResponse(result, compensationInput)` and register the rollback.
4. **Never use `any`.** Repo-wide rule from `CLAUDE.md`. Use the generated types from `@mercurjs/types` and Medusa's `@medusajs/framework/types`.
5. **Migrations are generated, not hand-written from scratch.** Change the model, then generate. Hand-editing is only for data backfills.
6. **Bun only.** Never `npm`, `yarn`, or `pnpm` in this repo.

## Layout of a Module

`packages/core/src/modules/<name>/`

```
index.ts        Module definition — Module(NAME, { service })
service.ts      Extends MedusaService({ Model, ... }) — CRUD is generated
models/         DML model definitions (model.define(...))
migrations/     Generated Mikro-ORM migrations + .snapshot-*.json
repositories/   Only when a generated method cannot express the query
loaders/        Run at boot (seeding defaults, registering providers)
utils/          Pure helpers
```

`MedusaService({ Seller })` already generates `listSellers`, `retrieveSeller`, `createSellers`, `updateSellers`, `deleteSellers`, `softDeleteSellers`, and their `*AndCount` variants. **Check for a generated method before writing one.** Add a custom method only for logic the generator cannot express.

## Models

Defined with the DML, not decorators:

```ts
import { model } from '@medusajs/framework/utils'

export const Seller = model.define('seller', {
  id: model.id({ prefix: 'sel' }).primaryKey(),
  name: model.text(),
  handle: model.text().unique(),
  status: model.enum(['pending_approval', 'open', 'suspended', 'terminated']),
  closed_from: model.dateTime().nullable(),
})
```

- Always set an `id` `prefix` — it is how records are identified in logs and API responses.
- `model.enum` values are persisted as strings; adding a value needs a migration.
- Relations **inside** one module use `model.hasMany` / `model.belongsTo`. Relations **across** modules are links, never model relations.

## Links

Cross-module relationships live in `packages/core/src/links/<a>-<b>-link.ts`:

```ts
import { defineLink } from '@medusajs/framework/utils'
import ProductModule from '@medusajs/medusa/product'
import SellerModule from '../modules/seller'

export default defineLink(ProductModule.linkable.product, SellerModule.linkable.seller)
```

- Read across a link with Query (`container.resolve(ContainerRegistrationKeys.QUERY)`), never by joining tables.
- Write link rows with `createRemoteLinkStep` / `dismissRemoteLinkStep` inside a workflow.
- A new link needs a migration run (`db:migrate`) — link tables are real tables.

## Workflows

`packages/core/src/workflows/<domain>/`, split into `steps/` and `workflows/`.

```ts
const createSellerStep = createStep(
  'create-seller',
  async (input: CreateSellerInput, { container }) => {
    const service = container.resolve(SELLER_MODULE)
    const seller = await service.createSellers(input)
    return new StepResponse(seller, seller.id)          // 2nd arg -> compensation input
  },
  async (sellerId, { container }) => {                   // compensation
    if (!sellerId) return
    await container.resolve(SELLER_MODULE).deleteSellers(sellerId)
  }
)

export const createSellerWorkflow = createWorkflow(
  'create-seller',
  (input: CreateSellerInput) => {
    const seller = createSellerStep(input)
    return new WorkflowResponse(seller)
  }
)
```

- **Do not use plain `if` / `for` / `await` inside `createWorkflow`.** The body is a graph definition evaluated once, not runtime code. Use `when(...).then(...)`, `transform(...)`, and `parallelize(...)`.
- `transform()` is the only correct way to reshape a step's output before feeding another step. Reading `step.output.foo` directly in the body does not do what it looks like.
- Expose extension points with `createHook`; consumers register handlers rather than forking the workflow.
- Reuse Medusa's own workflows (`createProductsWorkflow`, `createOrderWorkflow`, ...) from `@medusajs/core-flows` instead of reimplementing commerce logic.

## API Routes

File-based under `packages/core/src/api/`. Path mirrors the URL; `[param]` is a path segment.

```
api/vendor/products/route.ts             ->  /vendor/products      (GET, POST)
api/vendor/products/[id]/route.ts        ->  /vendor/products/:id  (GET, POST, DELETE)
```

```ts
export const POST = async (req: AuthenticatedMedusaRequest<CreateProductType>, res: MedusaResponse) => {
  const sellerId = req.auth_context.actor_id
  const { result } = await createProductWorkflow(req.scope).run({ input: { ...req.validatedBody, seller_id: sellerId } })
  res.status(201).json({ product: result })
}
```

- Three surfaces, three meanings: `admin/*` = marketplace operator, `vendor/*` = seller-scoped, `store/*` = customer-facing. Put a route on the wrong surface and you create a privilege escalation.
- **Every `vendor/*` route must be seller-scoped.** Scope comes from the authenticated actor via middleware — never from a client-supplied `seller_id` in the body or query.
- Validation is Zod in `validators.ts`, wired through `validateAndTransformBody` in `middlewares.ts`. `req.validatedBody` is only populated when the middleware is registered.
- Response shaping (`fields`, `relations`, pagination) belongs in the route's query config, not in ad-hoc mapping.
- `zod` is pinned to `3.25.76` at the root for backend code. Some dashboard packages use zod 4 — do not "upgrade" a backend validator to v4 syntax.

## Migrations

```bash
cd apps/api
bunx medusa db:generate <MODULE_NAME>   # after changing models
bunx medusa db:migrate                  # apply, incl. link tables
```

- Generate from the module, then commit both the migration and the updated `.snapshot-*.json`. A missing snapshot update makes the next generation produce a wrong diff.
- Migrations are forward-only in practice. To change a shipped migration, add a new one.
- A model change with no migration fails at runtime, not at build time — `bun run build` will not catch it.

## Subscribers and Scheduled Jobs

- Subscribers: `packages/core/src/subscribers/<event>.ts`, default-export the handler plus `export const config = { event: 'seller.created' }`.
- Jobs export `config = { name, schedule }` with a cron expression. Jobs run on **every** server instance unless guarded — make handlers idempotent.
- Emit events with the event bus inside a workflow step, never directly from a route.

## Testing

```bash
bun run test:integration:http -- <pattern>   # ALWAYS pass a pattern
```

Never run bare `bun run test:integration:http` — it runs every package.

```ts
medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    it('scopes products to the seller', async () => {
      const { seller, headers } = await createSellerUser(getContainer())
      const res = await api.get('/vendor/products', headers)
      expect(res.status).toBe(200)
    })
  },
})
```

- Helpers for admin users, sellers, and customers live in `integration-tests/helpers` — use them rather than hand-rolling auth.
- Tests are grouped by surface: `http/<domain>/{admin,vendor,store}/<name>.spec.ts`.
- Bug fixes must ship a test. If the bug is reproducible, write the failing test first.

## Debugging Checklist

| Symptom | Likely cause |
|---|---|
| `AwilixResolutionError` / service not found | Module not registered in `medusa-config.ts`, or a duplicate `@medusajs/*` version bypassing the root override |
| Column does not exist | Model changed without `db:generate` + `db:migrate` |
| Workflow branch always runs | Used a plain `if` instead of `when().then()` |
| Step output is `undefined` downstream | Reshaped output outside `transform()` |
| Vendor sees another seller's data | Route trusts a client-supplied `seller_id` instead of `req.auth_context` |
| Link returns nothing | Link file added but `db:migrate` not run |
| `req.validatedBody` undefined | Validator not registered in `middlewares.ts` |

## Output Format

When adding a backend feature, produce in this order:
1. model change (if any) → `db:generate` → `db:migrate`
2. workflow steps with compensation, then the workflow
3. Zod validator + middleware registration
4. route on the correct surface, seller-scoped if `vendor/*`
5. integration test under the matching surface folder
6. `bun run lint` and `bun run build` green before finishing
