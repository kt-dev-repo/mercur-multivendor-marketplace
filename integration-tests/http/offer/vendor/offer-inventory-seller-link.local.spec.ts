import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
    createOffersWorkflow,
    createSellerInventoryItemsWorkflow,
} from "@mercurjs/core/workflows"
import { createSellerUser } from "../../../helpers/create-seller-user"
import { createVendorProduct } from "../../../helpers/create-product"

jest.setTimeout(180000)

// fix-cycle S4 / P0.4 — createOffersWorkflow links EVERY inventory item in a
// batch to input.offers[0].seller_id (create-offers.ts:122-125), regardless of
// which offer declared it. The three HTTP callers stamp a single seller so the
// bug is latent there; it is only reachable by a multi-seller batch, which the
// seeder is the only caller to pass today (hence the live skew: 1144 items on
// one seller). This exercises the workflow directly with a 2-seller batch.
//
// RED on a pristine tree: both sellers' items land on seller A.
// GREEN with overlay 008: each item links to the seller of its own offer,
// and the `?? ""` fallback no longer creates a seller_id="" link.
medusaIntegrationTestRunner({
    testSuite: ({ getContainer, api }) => {
        describe("[local] Offer inventory seller link (S4/P0.4)", () => {
            let appContainer: MedusaContainer

            const setupSeller = async (email: string, name: string) => {
                const { seller, member, headers } = await createSellerUser(
                    appContainer,
                    { email, name }
                )
                const product = await createVendorProduct(api, headers, {
                    title: `${name} Product`,
                    sku: `${name}-SKU-${Date.now()}`,
                })
                const shippingProfile = (
                    await api.post(
                        `/vendor/shipping-profiles`,
                        { name: `${name} Profile`, type: "default" },
                        headers
                    )
                ).data.shipping_profile
                return {
                    sellerId: seller.id as string,
                    createdBy: member.id as string,
                    variantId: product.variants[0].id as string,
                    shippingProfileId: shippingProfile.id as string,
                }
            }

            const sellerOfInventoryItem = async (inventoryItemId: string) => {
                const query = appContainer.resolve(
                    ContainerRegistrationKeys.QUERY
                )
                const { data } = await query.graph({
                    entity: "inventory_item",
                    fields: ["id", "seller.id"],
                    filters: { id: inventoryItemId },
                })
                return (data[0] as any)?.seller?.id as string | undefined
            }

            const allInventorySellerLinks = async () => {
                const query = appContainer.resolve(
                    ContainerRegistrationKeys.QUERY
                )
                const { data } = await query.graph({
                    entity: "inventory_item",
                    fields: ["id", "seller.id"],
                })
                return (data as any[])
                    .map((row) => row?.seller?.id)
                    .filter((id) => id !== undefined && id !== null)
            }

            const sellerIdsWithLinkedInventory = async () =>
                Array.from(new Set(await allInventorySellerLinks()))

            const linkedInventoryItemCount = async () =>
                (await allInventorySellerLinks()).length

            beforeAll(async () => {
                appContainer = getContainer()
            })

            it("S4-C1: each created inventory item links to the seller that declared it", async () => {
                const a = await setupSeller(
                    `s4-a-${Date.now()}@test.com`,
                    "S4A"
                )
                const b = await setupSeller(
                    `s4-b-${Date.now()}@test.com`,
                    "S4B"
                )

                const { result: offers } = await createOffersWorkflow(
                    appContainer
                ).run({
                    input: {
                        offers: [
                            {
                                seller_id: a.sellerId,
                                created_by: a.createdBy,
                                sku: `S4A-OFFER-${Date.now()}`,
                                variant_id: a.variantId,
                                shipping_profile_id: a.shippingProfileId,
                                inventory_items: [
                                    { title: "A-INV", required_quantity: 1 },
                                ],
                                prices: [
                                    { amount: 4400, currency_code: "usd" },
                                ],
                            },
                            {
                                seller_id: b.sellerId,
                                created_by: b.createdBy,
                                sku: `S4B-OFFER-${Date.now()}`,
                                variant_id: b.variantId,
                                shipping_profile_id: b.shippingProfileId,
                                inventory_items: [
                                    { title: "B-INV", required_quantity: 1 },
                                ],
                                prices: [
                                    { amount: 9900, currency_code: "usd" },
                                ],
                            },
                        ],
                    },
                })

                const query = appContainer.resolve(
                    ContainerRegistrationKeys.QUERY
                )
                const byOffer: Record<string, string> = {}
                for (const offer of offers as any[]) {
                    const { data } = await query.graph({
                        entity: "offer",
                        fields: ["id", "seller_id", "inventory_items.id"],
                        filters: { id: offer.id },
                    })
                    const row = data[0] as any
                    for (const item of row.inventory_items ?? []) {
                        byOffer[item.id] = row.seller_id
                    }
                }

                // For each created inventory item, the seller it is linked to
                // must equal the seller of the offer that declared it.
                for (const [itemId, declaringSeller] of Object.entries(
                    byOffer
                )) {
                    const linkedSeller = await sellerOfInventoryItem(itemId)
                    // RED today: every item links to offers[0].seller_id (A),
                    // so seller B's item reports seller A here.
                    expect(linkedSeller).toEqual(declaringSeller)
                }

                // Sanity: the two offers really are on two different sellers.
                const sellers = new Set(Object.values(byOffer))
                expect(sellers.size).toEqual(2)
            })

            it("S4-C2: no link is ever created for an empty seller_id", async () => {
                const a = await setupSeller(
                    `s4-c2-${Date.now()}@test.com`,
                    "S4C2"
                )

                // The `?? ""` fallback used to turn a missing seller into a
                // link against seller "". It must now be refused outright.
                await expect(
                    createOffersWorkflow(appContainer).run({
                        input: {
                            offers: [
                                {
                                    seller_id: "",
                                    created_by: a.createdBy,
                                    sku: `S4C2-OFFER-${Date.now()}`,
                                    variant_id: a.variantId,
                                    shipping_profile_id: a.shippingProfileId,
                                    inventory_items: [
                                        { title: "C2-INV", required_quantity: 1 },
                                    ],
                                    prices: [
                                        { amount: 1000, currency_code: "usd" },
                                    ],
                                },
                            ],
                        },
                    })
                ).rejects.toBeTruthy()

                // An empty batch must not link anything either.
                await createOffersWorkflow(appContainer)
                    .run({ input: { offers: [] } })
                    .catch(() => undefined)

                expect(await sellerIdsWithLinkedInventory()).not.toContain("")
            })

            it("S4-C4: a failure after the link step dismisses exactly the links it created", async () => {
                const a = await setupSeller(
                    `s4-c4-${Date.now()}@test.com`,
                    "S4C4"
                )

                const before = await linkedInventoryItemCount()

                // A variant id that resolves to nothing makes the `stripped`
                // transform throw NOT_FOUND, which happens after
                // linkSellerInventoryItemStep has already written its rows.
                await expect(
                    createOffersWorkflow(appContainer).run({
                        input: {
                            offers: [
                                {
                                    seller_id: a.sellerId,
                                    created_by: a.createdBy,
                                    sku: `S4C4-OFFER-${Date.now()}`,
                                    variant_id: "variant_does_not_exist",
                                    shipping_profile_id: a.shippingProfileId,
                                    inventory_items: [
                                        { title: "C4-INV", required_quantity: 1 },
                                    ],
                                    prices: [
                                        { amount: 1000, currency_code: "usd" },
                                    ],
                                },
                            ],
                        },
                    })
                ).rejects.toBeTruthy()

                expect(await linkedInventoryItemCount()).toEqual(before)
            })

            it("S4-C5: the step's other caller still links to its single seller", async () => {
                const a = await setupSeller(
                    `s4-c5-${Date.now()}@test.com`,
                    "S4C5"
                )

                const { result } = await createSellerInventoryItemsWorkflow(
                    appContainer
                ).run({
                    input: {
                        seller_id: a.sellerId,
                        inventory_items: [
                            { title: "C5-INV-1", sku: `C5-1-${Date.now()}` },
                            { title: "C5-INV-2", sku: `C5-2-${Date.now()}` },
                        ],
                    },
                })

                expect((result as any[]).length).toEqual(2)
                for (const item of result as any[]) {
                    expect(await sellerOfInventoryItem(item.id)).toEqual(
                        a.sellerId
                    )
                }
            })
        })
    },
})
