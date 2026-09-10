import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createOffersWorkflow } from "@mercurjs/core/workflows"
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
        })
    },
})
