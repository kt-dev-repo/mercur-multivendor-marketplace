import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import {
    IRegionModuleService,
    ISalesChannelModuleService,
    MedusaContainer,
} from "@medusajs/framework/types"
import {
    ContainerRegistrationKeys,
    Modules,
} from "@medusajs/framework/utils"
import {
    generatePublishableKey,
    generateStoreHeaders,
} from "../../../helpers/create-admin-user"
import { createCustomerUser } from "../../../helpers/create-customer-user"
import {
    completeSplitOrderCheckout,
    seedSellerOfferWithShipping,
} from "../../../helpers/split-order-checkout"

jest.setTimeout(180000)

// fix-cycle S3 / P0.5 — GET /store/orders/:id returns 200 with only the
// publishable key, leaking email, full name, street address, postcode and
// order total. The sibling list route filters on req.auth_context.actor_id;
// the :id route passes only { is_draft_order: false }.
//
// QC-AMENDS-PO: Medusa 2.20.1 deliberately does NOT authenticate
// /store/orders/:id (matcher carries no authenticate; handler has a TODO), so
// req.auth_context is undefined and a naive actor_id dereference would 500.
//
// RED on a pristine tree: S3-A GET with publishable key only -> 200 + PII.
// GREEN with overlay 007: 401 (no customer context); B's token -> 404.
medusaIntegrationTestRunner({
    testSuite: ({ getContainer, api }) => {
        describe("[local] Store order detail PII leak (S3/P0.5)", () => {
            let appContainer: MedusaContainer
            let storeHeaders: any
            let region: any
            let salesChannel: any
            let orderId: string
            let customerA: any
            let customerB: any
            const BUYER_EMAIL = "s3-buyer@test.com"

            beforeAll(async () => {
                appContainer = getContainer()
            })

            beforeEach(async () => {
                const scModule =
                    appContainer.resolve<ISalesChannelModuleService>(
                        Modules.SALES_CHANNEL
                    )
                salesChannel = await scModule.createSalesChannels({
                    name: "Default Store",
                })
                const regionModule =
                    appContainer.resolve<IRegionModuleService>(Modules.REGION)
                region = await regionModule.createRegions({
                    name: "Test Region",
                    currency_code: "usd",
                    countries: ["us"],
                })
                const link = appContainer.resolve(ContainerRegistrationKeys.LINK)
                await link.create({
                    [Modules.REGION]: { region_id: region.id },
                    [Modules.PAYMENT]: {
                        payment_provider_id: "pp_system_default",
                    },
                })
                const apiKey = await generatePublishableKey(appContainer)

                customerA = await createCustomerUser(appContainer, {
                    email: BUYER_EMAIL,
                    first_name: "Buyer",
                    last_name: "Test",
                })
                customerB = await createCustomerUser(appContainer, {
                    email: "s3-other@test.com",
                    first_name: "Other",
                    last_name: "Nosy",
                })

                // Customer A's own authenticated store headers.
                storeHeaders = {
                    headers: {
                        ...generateStoreHeaders({ publishableKey: apiKey })
                            .headers,
                        ...customerA.headers.headers,
                    },
                }

                const seed = await seedSellerOfferWithShipping({
                    container: appContainer,
                    api,
                    salesChannelId: salesChannel.id,
                    email: `s3-seller-${Date.now()}@test.com`,
                    name: "S3 Seller",
                    stocked: 100,
                    offerPrice: 4400,
                })
                const order = await completeSplitOrderCheckout({
                    container: appContainer,
                    api,
                    storeHeaders,
                    regionId: region.id,
                    salesChannelId: salesChannel.id,
                    offerId: seed.offer.id,
                    email: BUYER_EMAIL,
                })
                orderId = order.id

                // The publishable-key-only headers used by the attacker.
                ;(globalThis as any).__pubHeaders = generateStoreHeaders({
                    publishableKey: apiKey,
                })
            })

            it("S3-A: publishable key only (no customer JWT) must NOT return the order", async () => {
                const pubHeaders = (globalThis as any).__pubHeaders
                const resp = await api
                    .get(`/store/orders/${orderId}`, pubHeaders)
                    .catch((e: any) => e.response)
                // RED today: 200 with email + shipping address + total.
                // 404 accepted as documented fallback; 500 is a FAIL.
                expect([401, 404]).toContain(resp.status)
                expect(resp.status).not.toEqual(500)
            })

            it("S3-C: customer B must get 404 on customer A's order", async () => {
                const headers = {
                    headers: {
                        ...(globalThis as any).__pubHeaders.headers,
                        ...customerB.headers.headers,
                    },
                }
                const resp = await api
                    .get(`/store/orders/${orderId}`, headers)
                    .catch((e: any) => e.response)
                expect(resp.status).toEqual(404)
            })

            it("S3-D: customer A sees their own order (200, payload intact)", async () => {
                const resp = await api.get(
                    `/store/orders/${orderId}`,
                    storeHeaders
                )
                expect(resp.status).toEqual(200)
                expect(resp.data.order.id).toEqual(orderId)
            })

            it("S3-E: a client-supplied ?customer_id must not widen access", async () => {
                const pubHeaders = (globalThis as any).__pubHeaders
                const resp = await api
                    .get(
                        `/store/orders/${orderId}?customer_id=${customerA.customer.id}`,
                        pubHeaders
                    )
                    .catch((e: any) => e.response)
                expect([401, 404, 400]).toContain(resp.status)
                expect(resp.status).not.toEqual(200)
            })
        })
    },
})
