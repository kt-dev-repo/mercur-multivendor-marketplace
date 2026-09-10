import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { MedusaContainer } from "@medusajs/framework/types"
import { createSellerUser } from "../../../helpers/create-seller-user"
import { createVendorProduct } from "../../../helpers/create-product"

jest.setTimeout(120000)

// fix-cycle S5 / P0.3 — vendor product routes assert no ownership.
// `/vendor/products/:id` GET has only query validation, POST only body+query,
// DELETE `middlewares: []`, cancel only body validation. The only tenant
// boundary is `policies: [...]`, which is inert while featureFlags.rbac=false
// (this instance's default). So seller B can read A's draft and queue
// product_change writes against A's product.
//
// RED on a pristine tree (rbac off): S5-A POST 202, S5-B DELETE 202,
// S5-C cancel 200, S5-D GET of A's draft 200. GREEN with overlay 009: 404.
//
// QC-AMENDS-PO S5-D: the gate is list/detail consistency, not blanket 404.
// A PUBLISHED shared-catalogue product stays visible to B; only the draft
// (neither owned by B nor published) must 404.
medusaIntegrationTestRunner({
    testSuite: ({ getContainer, api }) => {
        describe("[local] Vendor product ownership (S5/P0.3)", () => {
            let appContainer: MedusaContainer
            let sellerA: any
            let sellerB: any
            let draftOfA: any
            let publishedOfA: any

            beforeAll(async () => {
                appContainer = getContainer()
            })

            beforeEach(async () => {
                const tag = `s5_${Date.now()}`
                sellerA = await createSellerUser(appContainer, {
                    email: `s5-a-${tag}@test.com`,
                    name: `S5 Seller A ${tag}`,
                })
                sellerB = await createSellerUser(appContainer, {
                    email: `s5-b-${tag}@test.com`,
                    name: `S5 Seller B ${tag}`,
                })
                draftOfA = await createVendorProduct(api, sellerA.headers, {
                    title: `A secret draft ${tag}`,
                    sku: `S5-A-DRAFT-${tag}`,
                    status: "draft",
                })
                publishedOfA = await createVendorProduct(api, sellerA.headers, {
                    title: `A published ${tag}`,
                    sku: `S5-A-PUB-${tag}`,
                    status: "published",
                })
            })

            it("S5-F: enforcement must hold with rbac off (instance default)", async () => {
                const { FeatureFlag } = await import(
                    "@medusajs/framework/utils"
                )
                expect(FeatureFlag.isFeatureEnabled("rbac")).toBe(false)
            })

            it("S5-E: seller A can read + write its own products (control)", async () => {
                const get = await api.get(
                    `/vendor/products/${draftOfA.id}`,
                    sellerA.headers
                )
                expect(get.status).toEqual(200)
                const post = await api.post(
                    `/vendor/products/${draftOfA.id}`,
                    { title: "A renames own draft" },
                    sellerA.headers
                )
                expect(post.status).toEqual(202)
            })

            it("S5-D: seller B must NOT read seller A's DRAFT (absent from B's list)", async () => {
                const list = await api.get(
                    `/vendor/products?limit=200&fields=id`,
                    sellerB.headers
                )
                const ids = list.data.products.map((p: any) => p.id)
                expect(ids).not.toContain(draftOfA.id)

                const resp = await api
                    .get(`/vendor/products/${draftOfA.id}`, sellerB.headers)
                    .catch((e: any) => e.response)
                // RED today: 200 leaking A's unpublished product.
                expect(resp.status).toEqual(404)
            })

            it("S5-A: seller B -> POST /vendor/products/{A's id} is 404", async () => {
                const resp = await api
                    .post(
                        `/vendor/products/${draftOfA.id}`,
                        { title: "HIJACKED BY B" },
                        sellerB.headers
                    )
                    .catch((e: any) => e.response)
                // RED today: 202, a product_change authored by B on A's product.
                expect(resp.status).toEqual(404)
            })

            it("S5-B: seller B -> DELETE /vendor/products/{A's id} is 404", async () => {
                const resp = await api
                    .delete(
                        `/vendor/products/${draftOfA.id}`,
                        sellerB.headers
                    )
                    .catch((e: any) => e.response)
                expect(resp.status).toEqual(404)
            })

            it("S5-C: seller B -> POST /vendor/products/{A's id}/cancel is 404", async () => {
                const resp = await api
                    .post(
                        `/vendor/products/${draftOfA.id}/cancel`,
                        {},
                        sellerB.headers
                    )
                    .catch((e: any) => e.response)
                expect(resp.status).toEqual(404)
            })

            it("S5-L: a client-supplied seller_id in the body does not widen access", async () => {
                const resp = await api
                    .post(
                        `/vendor/products/${draftOfA.id}`,
                        { title: "scope escalation", seller_id: sellerA.seller.id },
                        sellerB.headers
                    )
                    .catch((e: any) => e.response)
                // Defense-in-depth: a body seller_id must never let B write A's
                // product. Rejection as 400 (strict body) or 404 (ownership)
                // both satisfy this; a 2xx would be the leak.
                expect(resp.status).toBeGreaterThanOrEqual(400)
            })
        })
    },
})
