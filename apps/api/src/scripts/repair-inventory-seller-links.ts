import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MercurModules } from "@mercurjs/types"
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"

/**
 * Repair `inventory_item ↔ seller` links so every inventory item belongs to the
 * seller of the offer that declared it.
 *
 * THIS SCRIPT IS NOT A SUBSTITUTE FOR OVERLAY `008`. It repairs data that
 * `createOffersWorkflow` corrupted by linking every item in a batch to
 * `offers[0].seller_id`. Without overlay `008` applied, the data regresses the
 * next time anything calls that workflow with a mixed-seller batch.
 *
 * Ownership is derived as `inventory_item → offer_inventory_item → offer.seller_id`.
 * An item that resolves to zero or to more than one seller is AMBIGUOUS: the run
 * aborts and writes nothing rather than guessing.
 *
 * Dry run is the default. Nothing is written without the `apply` verb.
 *
 *   # report only (dry run)
 *   bun --cwd apps/api run medusa exec ./src/scripts/repair-inventory-seller-links.ts
 *
 *   # write, after snapshotting the current pairs
 *   bun --cwd apps/api run medusa exec ./src/scripts/repair-inventory-seller-links.ts apply
 *
 *   # undo, from the snapshot the apply run printed
 *   bun --cwd apps/api run medusa exec ./src/scripts/repair-inventory-seller-links.ts \
 *     restore .medusa/repair-inventory-seller-links-<timestamp>.json apply
 *
 * Idempotent: a second apply run reports 0 changes and leaves the rows alone.
 */

type Pair = { inventory_item_id: string; seller_id: string }

const PAGE = 500

const paginate = async <T>(
  fetchPage: (skip: number, take: number) => Promise<T[]>
): Promise<T[]> => {
  const all: T[] = []
  for (let skip = 0; ; skip += PAGE) {
    const page = await fetchPage(skip, PAGE)
    all.push(...page)
    if (page.length < PAGE) {
      return all
    }
  }
}

const sortPairs = (pairs: Pair[]): Pair[] =>
  [...pairs].sort((a, b) =>
    a.inventory_item_id === b.inventory_item_id
      ? a.seller_id.localeCompare(b.seller_id)
      : a.inventory_item_id.localeCompare(b.inventory_item_id)
  )

const key = (pair: Pair) => `${pair.inventory_item_id}::${pair.seller_id}`

const countBySeller = (pairs: Pair[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const pair of pairs) {
    counts[pair.seller_id] = (counts[pair.seller_id] ?? 0) + 1
  }
  return counts
}

const toLinkDefinitions = (pairs: Pair[]) =>
  pairs.map((pair) => ({
    [Modules.INVENTORY]: { inventory_item_id: pair.inventory_item_id },
    [MercurModules.SELLER]: { seller_id: pair.seller_id },
  }))

export default async function repairInventorySellerLinks({
  container,
  args,
}: ExecArgs) {
  // `medusa exec` hands the trailing words through as positionals; yargs rejects
  // anything that looks like an option, so the verbs are bare words.
  const argv = args ?? []
  const apply = argv.includes("apply")
  const restoreIndex = argv.indexOf("restore")
  const restorePath = restoreIndex >= 0 ? argv[restoreIndex + 1] : undefined

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const link = container.resolve(ContainerRegistrationKeys.LINK)

  const currentPairs = await paginate<Pair>(async (skip, take) => {
    const { data } = await query.graph({
      entity: "inventory_item",
      fields: ["id", "seller.id"],
      pagination: { skip, take },
    })
    return (data as { id: string; seller?: { id: string } | null }[])
      .filter((row) => Boolean(row.seller?.id))
      .map((row) => ({
        inventory_item_id: row.id,
        seller_id: row.seller!.id,
      }))
  })

  console.log(
    `current inventory_item ↔ seller links: ${currentPairs.length}`,
    countBySeller(currentPairs)
  )

  if (restorePath) {
    const snapshotPath = resolve(process.cwd(), restorePath)
    const snapshot = sortPairs(
      JSON.parse(readFileSync(snapshotPath, "utf-8")) as Pair[]
    )
    console.log(
      `restoring ${snapshot.length} pairs from ${snapshotPath}` +
        (apply ? "" : " (dry run — add `apply` to write)")
    )

    if (!apply) {
      return
    }

    if (currentPairs.length) {
      await link.dismiss(toLinkDefinitions(currentPairs))
    }
    if (snapshot.length) {
      await link.create(toLinkDefinitions(snapshot))
    }
    console.log("restore complete")
    return
  }

  // inventory_item → offer → seller_id
  const offerRows = await paginate<{
    seller_id: string | null
    inventory_items?: { id: string }[] | null
  }>(async (skip, take) => {
    const { data } = await query.graph({
      entity: "offer",
      fields: ["id", "seller_id", "inventory_items.id"],
      pagination: { skip, take },
    })
    return data as {
      seller_id: string | null
      inventory_items?: { id: string }[] | null
    }[]
  })

  const sellersByItem = new Map<string, Set<string>>()
  for (const offer of offerRows) {
    for (const item of offer.inventory_items ?? []) {
      const sellers = sellersByItem.get(item.id) ?? new Set<string>()
      if (offer.seller_id) {
        sellers.add(offer.seller_id)
      }
      sellersByItem.set(item.id, sellers)
    }
  }

  const ambiguous: string[] = []
  const desiredPairs: Pair[] = []
  for (const [inventoryItemId, sellers] of sellersByItem) {
    if (sellers.size !== 1) {
      ambiguous.push(inventoryItemId)
      continue
    }
    desiredPairs.push({
      inventory_item_id: inventoryItemId,
      seller_id: [...sellers][0],
    })
  }

  const unresolvable = currentPairs
    .map((pair) => pair.inventory_item_id)
    .filter((id) => !sellersByItem.has(id))

  if (ambiguous.length || unresolvable.length) {
    console.error(
      "ABORTING — ownership is not derivable for every item; nothing was written."
    )
    if (ambiguous.length) {
      console.error(
        `  items resolving to 0 or >1 sellers (${ambiguous.length}): ${ambiguous
          .slice(0, 20)
          .join(", ")}${ambiguous.length > 20 ? " …" : ""}`
      )
    }
    if (unresolvable.length) {
      console.error(
        `  linked items with no offer (${unresolvable.length}): ${unresolvable
          .slice(0, 20)
          .join(", ")}${unresolvable.length > 20 ? " …" : ""}`
      )
    }
    throw new Error("inventory→seller ownership is ambiguous")
  }

  const currentKeys = new Set(currentPairs.map(key))
  const desiredKeys = new Set(desiredPairs.map(key))

  const toCreate = desiredPairs.filter((pair) => !currentKeys.has(key(pair)))
  const toDismiss = currentPairs.filter((pair) => !desiredKeys.has(key(pair)))

  console.log(
    `offer-derived ownership: ${desiredPairs.length}`,
    countBySeller(desiredPairs)
  )
  console.log(`rows to dismiss: ${toDismiss.length}`)
  console.log(`rows to create:  ${toCreate.length}`)

  if (!toCreate.length && !toDismiss.length) {
    console.log("nothing to do — links already match offer-derived ownership")
    return
  }

  if (!apply) {
    console.log("DRY RUN — nothing written. Re-run with `apply` to write.")
    return
  }

  const snapshotPath = resolve(
    process.cwd(),
    `.medusa/repair-inventory-seller-links-${Date.now()}.json`
  )
  mkdirSync(dirname(snapshotPath), { recursive: true })
  writeFileSync(snapshotPath, JSON.stringify(sortPairs(currentPairs), null, 2))
  console.log(`snapshot written to ${snapshotPath}`)
  console.log(
    `to undo: medusa exec ./src/scripts/repair-inventory-seller-links.ts restore ${snapshotPath} apply`
  )

  if (toDismiss.length) {
    await link.dismiss(toLinkDefinitions(toDismiss))
  }
  if (toCreate.length) {
    await link.create(toLinkDefinitions(toCreate))
  }

  console.log(
    `repair complete: dismissed ${toDismiss.length}, created ${toCreate.length}`
  )
}
