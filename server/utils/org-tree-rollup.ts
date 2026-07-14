/*
 * Pure roll-up for the org-tree spend rollup endpoint (docs/design/org-tree-rollup.md).
 * Builds the nested tree rooted at `rootId`, rolling each node's spend up its subtree
 * (post-order), sorts children by rolled spend desc, and computes pctOfRoot.
 *
 * Two honesty guards keep the all-up total truthful:
 *  - A non-root unit whose parent is missing from the loaded set (parent retired, out of
 *    load, or null) is RE-PARENTED to the root rather than dropped — so a live unit under
 *    a retired ancestor never silently disappears, and a synthetic region root (parent=null
 *    on every top-level BU) gathers the whole forest.
 *  - Spend that lands on a unit NOT in the loaded tree at all (e.g. a retired unit still
 *    carrying ledger spend) is returned as `orphanCostUsd` so the caller can surface it.
 *
 * CONTRACT: because every loaded unit attaches to the tree (re-parenting to root when its
 * parent is missing), the caller MUST pass only the units that belong under `rootId` — i.e.
 * exactly the rooted subtree, or the whole region for a synthetic root. The endpoint enforces
 * this in SQL (region_id + `path <@ root.path` clamp), so an out-of-subtree unit is never
 * loaded. Passing unrelated units (a sibling subtree, or the real root above a re-root) would
 * wrongly fold their spend in — that scoping is the query's job, not this pure builder's.
 *
 * Pure (no DB) so the roll-up maths is unit-tested in isolation.
 */
export interface RollupUnit {
  id: string
  parentId: string | null
  code: string
  displayName: string
  unitType: string
  isCostOwningUnit: boolean
}

export interface VendorUsd {
  claude: number
  copilot: number
  other: number
}

export interface UnitSpend {
  costUsd: number
  tokens: number
  /** distinct teammates who EMITTED to this node (point-in-time home), not current members. */
  emitterCount: number
  /** per-vendor cost AT THIS NODE (own); rolled up the subtree by buildRollupTree. Optional —
   *  defaults to zeros so callers that don't need the split (existing tests) are unaffected. */
  vendorUsd?: VendorUsd
  /** distinct teammate ids who emitted AT THIS NODE; rolled as a SET (union) so the subtree
   *  user count is a true distinct count, not a sum. Optional. */
  teammateIds?: string[]
}

export interface RollupNode extends RollupUnit {
  ownCostUsd: number
  ownTokens: number
  rolledCostUsd: number
  rolledTokens: number
  ownEmitterCount: number
  /** rolled per-vendor cost over the subtree (claude / copilot / other). */
  vendorUsd: VendorUsd
  /** rolled DISTINCT emitter count over the subtree (set union, not a sum). */
  userCount: number
  childCount: number
  /** node.rolledCostUsd / root.rolledCostUsd; null when the root total is <= 0. */
  pctOfRoot: number | null
  children: RollupNode[]
}

export function buildRollupTree(
  units: RollupUnit[],
  spendByUnit: Map<string, UnitSpend>,
  rootId: string,
): { root: RollupNode; orphanCostUsd: number; orphanTokens: number } {
  const byId = new Map<string, RollupNode>()
  // Own distinct emitters per node, rolled as a SET union (a distinct count can't be summed).
  const ownUsers = new Map<string, string[]>()
  for (const u of units) {
    const s = spendByUnit.get(u.id)
    ownUsers.set(u.id, s?.teammateIds ?? [])
    byId.set(u.id, {
      ...u,
      ownCostUsd: s?.costUsd ?? 0,
      ownTokens: s?.tokens ?? 0,
      rolledCostUsd: 0,
      rolledTokens: 0,
      ownEmitterCount: s?.emitterCount ?? 0,
      vendorUsd: { claude: s?.vendorUsd?.claude ?? 0, copilot: s?.vendorUsd?.copilot ?? 0, other: s?.vendorUsd?.other ?? 0 },
      userCount: 0,
      childCount: 0,
      pctOfRoot: null,
      children: [],
    })
  }
  const root = byId.get(rootId)
  if (!root) throw new Error(`org-tree-rollup: root ${rootId} not in loaded units`)

  // Link children to parents. A non-root unit attaches to its parent when that parent is
  // in the loaded set; otherwise (parent retired / outside the load / null) it attaches to
  // the ROOT so its spend stays in the all-up and visible — never silently dropped. This
  // also lets a synthetic region root gather every top-level BU (all parent=null).
  for (const n of byId.values()) {
    if (n.id === rootId) continue
    const parent = n.parentId && byId.has(n.parentId) ? byId.get(n.parentId)! : root
    parent.children.push(n)
  }

  // Post-order: roll children first, accumulate, then sort children by rolled spend desc.
  // Returns the subtree's distinct-emitter SET so the parent can union (not sum) it.
  const rollup = (n: RollupNode): Set<string> => {
    let cost = n.ownCostUsd
    let tokens = n.ownTokens
    // n.vendorUsd starts as the node's OWN split; accumulate children into it.
    const users = new Set<string>(ownUsers.get(n.id) ?? [])
    for (const c of n.children) {
      const childUsers = rollup(c)
      cost += c.rolledCostUsd
      tokens += c.rolledTokens
      n.vendorUsd.claude += c.vendorUsd.claude
      n.vendorUsd.copilot += c.vendorUsd.copilot
      n.vendorUsd.other += c.vendorUsd.other
      childUsers.forEach((u) => users.add(u))
    }
    n.children.sort((a, b) => b.rolledCostUsd - a.rolledCostUsd)
    n.childCount = n.children.length
    n.rolledCostUsd = cost
    n.rolledTokens = tokens
    n.userCount = users.size
    return users
  }
  rollup(root)

  const total = root.rolledCostUsd
  const setPct = (n: RollupNode): void => {
    n.pctOfRoot = total > 0 ? n.rolledCostUsd / total : null
    n.children.forEach(setPct)
  }
  setPct(root)

  // Spend on a unit not represented in the loaded tree (retired / outside the load) —
  // surface, never drop, so the all-up stays honest.
  let orphanCostUsd = 0
  let orphanTokens = 0
  for (const [unitId, s] of spendByUnit) {
    if (!byId.has(unitId)) {
      orphanCostUsd += s.costUsd
      orphanTokens += s.tokens
    }
  }
  return { root, orphanCostUsd, orphanTokens }
}
