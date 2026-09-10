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
import { seedSellerOfferWithShipping } from "../../../helpers/split-order-checkout"

jest.setTimeout(180000)

// fix-cycle S2 / P0.2 — cart completion is not idempotent.
// complete-cart-with-split-orders.ts queries order_group with
// fields:["cart_id"], so orderGroup?.data?.id is always undefined and the
// create branch always runs. One cart -> many order groups.
//
// RED on a pristine tree:
//   - sequential complete #2 -> a SECOND order_group (2 total)
//   - 5 concurrent completes -> 5 order_groups, N*5 orders, 1 payment
// GREEN with overlay 006: sequential #2 -> 409, race -> exactly 1 order_group.
medusaIntegrationTestRunner({
    testSuite: ({ getContainer, api }) => {
        describe("[local] Cart completion idempotency (S2/P0.2)", () => {
            let appContainer: MedusaContainer
            let baseStoreHeaders: any
            let region: any
            let salesChannel: any
            let offerA: string
            let offerB: string

            const createBuiltCart = async (offerIds: string[]) => {
                const cart = (
                    await api.post(
                        `/store/carts`,
                        {
                            region_id: region.id,
                            sales_channel_id: salesChannel.id,
                            currency_code: "usd",
                        },
                        baseStoreHeaders
                    )
                ).data.cart
                for (const oid of offerIds) {
                    await api.post(
                        `/store/carts/${cart.id}/line-items`,
                        { offer_id: oid, quantity: 1 },
                        baseStoreHeaders
                    )
                }
                const address = {
                    first_name: "Buyer",
                    last_name: "Test",
                    address_1: "123 Main St",
                    city: "New York",
                    country_code: "us",
                    postal_code: "10001",
                }
                await api.post(
                    `/store/carts/${cart.id}`,
                    {
                        email: "s2-buyer@test.com",
                        shipping_address: address,
                        billing_address: address,
                    },
                    baseStoreHeaders
                )
                const opts = Object.values(
                    (
                        await api.get(
                            `/store/shipping-options?cart_id=${cart.id}`,
                            baseStoreHeaders
                        )
                    ).data.shipping_options as Record<string, any[]>
                ).flat()
                for (const opt of opts) {
                    await api.post(
                        `/store/carts/${cart.id}/shipping-methods`,
                        { option_id: opt.id },
                        baseStoreHeaders
                    )
                }
                const pc = (
                    await api.post(
                        `/store/payment-collections`,
                        { cart_id: cart.id },
                        baseStoreHeaders
                    )
                ).data.payment_collection
                await api.post(
                    `/store/payment-collections/${pc.id}/payment-sessions`,
                    { provider_id: "pp_system_default" },
                    baseStoreHeaders
                )
                return cart.id as string
            }

            const orderGroupCount = async (cartId: string) => {
                const query = appContainer.resolve(
                    ContainerRegistrationKeys.QUERY
                )
                const { data } = await query.graph({
                    entity: "order_group",
                    fields: ["id"],
                    filters: { cart_id: cartId },
                })
                return data.length
            }

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
                baseStoreHeaders = generateStoreHeaders({
                    publishableKey: apiKey,
                })

                offerA = (
                    await seedSellerOfferWithShipping({
                        container: appContainer,
                        api,
                        salesChannelId: salesChannel.id,
                        email: `s2-a-${Date.now()}@test.com`,
                        name: "S2 Seller A",
                        stocked: 100,
                        offerPrice: 4400,
                    })
                ).offer.id
                offerB = (
                    await seedSellerOfferWithShipping({
                        container: appContainer,
                        api,
                        salesChannelId: salesChannel.id,
                        email: `s2-b-${Date.now()}@test.com`,
                        name: "S2 Seller B",
                        stocked: 100,
                        offerPrice: 9900,
                    })
                ).offer.id
            })

            it("S2-A: sequential complete #2 must not create a second order group", async () => {
                const cartId = await createBuiltCart([offerA])
                const first = await api.post(
                    `/store/carts/${cartId}/complete`,
                    {},
                    baseStoreHeaders
                )
                expect(first.status).toEqual(200)
                expect(first.data.type).toEqual("order_group")
                expect(await orderGroupCount(cartId)).toEqual(1)

                const second = await api
                    .post(`/store/carts/${cartId}/complete`, {}, baseStoreHeaders)
                    .catch((e: any) => e.response)
                // RED today: 200 + a SECOND order_group (count becomes 2).
                // GREEN: 409, count stays 1.
                expect(await orderGroupCount(cartId)).toEqual(1)
                expect(second.status).toEqual(409)
            })

            it("S2-D: 5 concurrent completes on one fresh cart -> exactly 1 order group", async () => {
                const cartId = await createBuiltCart([offerA, offerB])
                const N = 5
                const dispatched: number[] = []
                const resolved: number[] = []
                const t0 = Date.now()
                const calls = Array.from({ length: N }, () => {
                    dispatched.push(Date.now() - t0)
                    return api
                        .post(`/store/carts/${cartId}/complete`, {}, baseStoreHeaders)
                        .then((r: any) => {
                            resolved.push(Date.now() - t0)
                            return r
                        })
                        .catch((e: any) => {
                            resolved.push(Date.now() - t0)
                            return e.response
                        })
                })
                const results = await Promise.all(calls)

                // S2-E: prove the requests actually overlapped.
                const lastDispatch = Math.max(...dispatched)
                const firstResolve = Math.min(...resolved)
                expect(lastDispatch).toBeLessThan(firstResolve)

                // (6) no response is 5xx
                for (const r of results) {
                    expect(r.status).toBeLessThan(500)
                }
                // (1) exactly one order group
                expect(await orderGroupCount(cartId)).toEqual(1)
            })
        })
    },
})
