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
import { createSellerUser } from "../../../helpers/create-seller-user"
import {
    generatePublishableKey,
    generateStoreHeaders,
} from "../../../helpers/create-admin-user"
import { createVendorProduct } from "../../../helpers/create-product"

jest.setTimeout(120000)

// fix-cycle S1 / P0.1 — price tampering on the PUBLIC store add-line-item route.
// `StoreAddCartLineItem` exposes `unit_price` / `compare_at_unit_price`, and
// `route.ts` spreads `...item` into the add-to-cart workflow, so a client with
// only the (public) publishable key sets its own price.
//
// RED on a pristine tree:
//   - S1-A: unit_price:1 is accepted, cart total collapses from 220 -> 5 (HTTP 200)
//   - S1-C: unit_price:-100 yields HTTP 500 (raw downstream error)
// GREEN with overlay 005: both fields are unrecognised keys, `.strict()` -> 400.
medusaIntegrationTestRunner({
    testSuite: ({ getContainer, api }) => {
        describe("[local] Store line-item price tampering (S1/P0.1)", () => {
            let appContainer: MedusaContainer
            let storeHeaders: any
            let region: any
            let salesChannel: any
            let offerId: string
            const OFFER_PRICE = 4400
            const QTY = 5

            const seedOffer = async () => {
                const tag = `s1_${Date.now()}`
                const { headers } = await createSellerUser(appContainer, {
                    email: `s1-${tag}@test.com`,
                    name: `S1 Seller ${tag}`,
                })
                const stockLocation = (
                    await api.post(
                        `/vendor/stock-locations`,
                        { name: `WH ${tag}` },
                        headers
                    )
                ).data.stock_location
                await api.post(
                    `/vendor/stock-locations/${stockLocation.id}/sales-channels`,
                    { add: [salesChannel.id] },
                    headers
                )
                const product = await createVendorProduct(api, headers, {
                    title: `S1 Product ${tag}`,
                    sku: `S1-SKU-${tag}`,
                })
                await api.post(
                    `/vendor/sales-channels/${salesChannel.id}/products`,
                    { add: [product.id] },
                    headers
                )
                const shippingProfile = (
                    await api.post(
                        `/vendor/shipping-profiles`,
                        { name: `S1 Profile ${tag}`, type: "default" },
                        headers
                    )
                ).data.shipping_profile
                const offer = (
                    await api.post(
                        `/vendor/offers`,
                        {
                            sku: `S1-OFFER-${tag}`,
                            variant_id: product.variants[0].id,
                            shipping_profile_id: shippingProfile.id,
                            inventory_items: [
                                {
                                    title: `S1 Inv ${tag}`,
                                    required_quantity: 1,
                                    stock_levels: [
                                        {
                                            location_id: stockLocation.id,
                                            stocked_quantity: 100,
                                        },
                                    ],
                                },
                            ],
                            prices: [
                                { amount: OFFER_PRICE, currency_code: "usd" },
                            ],
                        },
                        headers
                    )
                ).data.offer
                return offer.id as string
            }

            const createCart = async () =>
                (
                    await api.post(
                        `/store/carts`,
                        {
                            region_id: region.id,
                            sales_channel_id: salesChannel.id,
                            currency_code: "usd",
                        },
                        storeHeaders
                    )
                ).data.cart

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
                storeHeaders = generateStoreHeaders({ publishableKey: apiKey })
                offerId = await seedOffer()
            })

            it("S1-E: normal add resolves the offer price server-side", async () => {
                const cart = await createCart()
                const resp = await api.post(
                    `/store/carts/${cart.id}/line-items`,
                    { offer_id: offerId, quantity: QTY },
                    storeHeaders
                )
                expect(resp.status).toEqual(200)
                expect(resp.data.cart.items[0].unit_price).toEqual(OFFER_PRICE)
                expect(resp.data.cart.total).toEqual(OFFER_PRICE * QTY)
            })

            it("S1-A: unit_price is rejected (400), not applied", async () => {
                const cart = await createCart()
                const resp = await api
                    .post(
                        `/store/carts/${cart.id}/line-items`,
                        { offer_id: offerId, quantity: QTY, unit_price: 1 },
                        storeHeaders
                    )
                    .catch((e: any) => e.response)
                // RED today: 200 with a tampered total of QTY*1.
                expect(resp.status).toEqual(400)
                expect(resp.data.type).toEqual("invalid_data")
            })

            it("S1-B: compare_at_unit_price is rejected (400)", async () => {
                const cart = await createCart()
                const resp = await api
                    .post(
                        `/store/carts/${cart.id}/line-items`,
                        {
                            offer_id: offerId,
                            quantity: QTY,
                            compare_at_unit_price: 1,
                        },
                        storeHeaders
                    )
                    .catch((e: any) => e.response)
                expect(resp.status).toEqual(400)
            })

            it("S1-C: unit_price:-100 is a clean 400, not a 500", async () => {
                const cart = await createCart()
                const resp = await api
                    .post(
                        `/store/carts/${cart.id}/line-items`,
                        { offer_id: offerId, quantity: QTY, unit_price: -100 },
                        storeHeaders
                    )
                    .catch((e: any) => e.response)
                // RED today: 500 (raw downstream error).
                expect(resp.status).toEqual(400)
            })

            it("S1-D: both fields at once are rejected (400)", async () => {
                const cart = await createCart()
                const resp = await api
                    .post(
                        `/store/carts/${cart.id}/line-items`,
                        {
                            offer_id: offerId,
                            quantity: QTY,
                            unit_price: 1,
                            compare_at_unit_price: 1,
                        },
                        storeHeaders
                    )
                    .catch((e: any) => e.response)
                expect(resp.status).toEqual(400)
            })
        })
    },
})
