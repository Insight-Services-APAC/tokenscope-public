/*
 * Placement derivation for cost-centre-unplaced users (mig 0068 region + the unit/practice
 * extension; docs/design/org-entra-region-derivation.md + manager-chain-unit-placement.md).
 * Walks the Entra manager chain and resolves a placement:
 *   - UNIT (practice): the nearest ancestor who is an active cou_owner of EXACTLY ONE
 *     cost-owning unit → place in that unit (Entra is the org truth → chargeable).
 *   - REGION: else the nearest ancestor who is a configured region_leader → region holding.
 *   - department → region (curated map) is also honoured (no-op at Insight, where department
 *     is uniformly "Services").
 *
 * UNIT ALWAYS WINS over region regardless of hop distance: a region-leader nearer than a
 * unit-owner must NOT short-circuit (a unit may sit above it). So the walk only breaks on a
 * UNIT hit; a region hit is remembered as a fallback and the walk keeps climbing.
 *
 * PURE-ish: the Graph manager fetch is injected (GetManager) so this is unit-testable with
 * fakes; the SQL maps are loaded by the store. Caches are created ONCE per worker run and
 * threaded through (AEUF's cross-user optimisation). A non-404 Graph error PROPAGATES (the
 * walk aborts before back-propagation) so a transient failure is never cached as a miss.
 */
import type { DirectoryUser } from '../azure/directory'
import type { PlacementDerivation } from './placement-service'
import {
  REGION_ATTRIBUTE_KEYS,
  normalizeMatchValue,
  type RegionAttributeKey,
} from '../../shared/placement/region-attributes'

/** A manager edge from the Entra `/users/{id}/manager` hop. */
export interface ManagerEdge {
  oid: string
  email: string | null
}

/** Fetch a user's manager (null = top of chart / no manager). MUST map 404 → null and
 *  PROPAGATE any other error (the walk aborts; the per-user worker isolation retries). */
export type GetManager = (oid: string) => Promise<ManagerEdge | null>

/** A cost-owning unit owned by a chain ancestor (cou_owner → org_unit). */
export interface OwnedUnit {
  orgUnitId: string
  regionId: string
}

/** The resolved placement from a chain walk. null = neither signal resolved. */
export type ChainPlacement =
  | { kind: 'unit'; orgUnitId: string; regionId: string; ownerOid: string }
  | { kind: 'region'; regionId: string }
  | null

export interface ChainCaches {
  /** oid → manager edge | null (top of chart). Shared across users in one run. */
  managerCache: Map<string, ManagerEdge | null>
  /** oid → fully-resolved ChainPlacement, back-propagated through each walked path so
   *  siblings short-circuit. Stores the FINAL outcome only (never a mid-walk region). */
  placementCache: Map<string, ChainPlacement>
}

/**
 * The curated directory→region rules, pre-indexed for lookup. `exact` is a
 * nested attribute→value→region map (O(1) hits, no string-composite key); the
 * `prefix` list is scanned longest-value-first so the most specific prefix wins.
 * Built by the store's loadDirectoryRegionRules().
 */
export interface RegionRuleSet {
  exact: Map<RegionAttributeKey, Map<string, string>>
  prefix: Array<{ attribute: RegionAttributeKey; value: string; regionId: string }>
}

const EMPTY_RULE_SET: RegionRuleSet = { exact: new Map(), prefix: [] }

// Compile-time guard: every catalog key MUST be a real string field on
// DirectoryUser, so dirAttrValue's lookup can't silently no-op if the catalog
// and the interface ever drift.
type _AssertAttrsAreDirectoryFields = RegionAttributeKey extends keyof DirectoryUser ? true : never
const _assertAttrsAreDirectoryFields: _AssertAttrsAreDirectoryFields = true
void _assertAttrsAreDirectoryFields

/** Read a directory attribute value off a DirectoryUser by key (nullable). */
function dirAttrValue(dir: DirectoryUser, attr: RegionAttributeKey): string | null {
  return dir[attr] ?? null
}

export interface AttributeMatch {
  regionId: string
  attribute: RegionAttributeKey
  /** True if a LOWER-precedence attribute also matched but to a DIFFERENT region
   *  (a misconfiguration worth surfacing; the highest-precedence match wins). */
  conflict: boolean
}

/**
 * Resolve a region from the directory rules, trying attributes in catalog
 * PRECEDENCE order (companyName → … → department). Exact match first, then prefix.
 * Highest-precedence hit wins; a divergent lower hit is flagged as a conflict.
 * Returns null when no attribute matches (→ manager-walk / global fallback).
 */
export function mapAttributesToRegion(
  dir: DirectoryUser,
  rules: RegionRuleSet = EMPTY_RULE_SET,
): AttributeMatch | null {
  const hits: Array<{ attribute: RegionAttributeKey; regionId: string }> = []
  for (const attr of REGION_ATTRIBUTE_KEYS) {
    const norm = normalizeMatchValue(dirAttrValue(dir, attr))
    if (!norm) continue
    let regionId = rules.exact.get(attr)?.get(norm)
    if (!regionId) {
      const pfx = rules.prefix.find((p) => p.attribute === attr && norm.startsWith(p.value))
      if (pfx) regionId = pfx.regionId
    }
    if (regionId) hits.push({ attribute: attr, regionId })
  }
  if (hits.length === 0) return null
  const winner = hits[0]!
  const conflict = hits.some((h) => h.regionId !== winner.regionId)
  return { regionId: winner.regionId, attribute: winner.attribute, conflict }
}

/**
 * Walk the manager chain and resolve a UNIT (cou_owner) or REGION (region_leader) placement.
 * Unit always wins over region. A cou_owner of >1 active cost-owning unit is AMBIGUOUS (we
 * can't tell which unit the report belongs to) → skipped as a unit target (keep climbing for
 * an unambiguous owner; else fall to region). Hop cap + cycle guard + cross-user cache.
 */
export async function resolvePlacementViaManagerChain(
  startOid: string,
  deps: {
    unitOwnerMap: Map<string, OwnedUnit[]>
    leaderMap: Map<string, string>
    getManager: GetManager
    caches: ChainCaches
    maxHops?: number
  },
): Promise<ChainPlacement> {
  const maxHops = deps.maxHops ?? 5
  const { managerCache, placementCache } = deps.caches
  const { unitOwnerMap, leaderMap } = deps
  const path: string[] = []
  let current = startOid
  let hops = 0
  let cachedHit: ChainPlacement | undefined
  let unitResult: ChainPlacement = null
  let regionResult: ChainPlacement = null
  while (current && hops <= maxHops) {
    const cached = placementCache.get(current)
    if (cached !== undefined) {
      cachedHit = cached // a previously fully-resolved outcome — reuse it
      break
    }
    // UNIT: an unambiguous (exactly one) cost-owning unit → nearest unit wins, unit beats
    // region → final. (>1 = ambiguous: skip as a unit target, keep climbing.)
    const owned = unitOwnerMap.get(current)
    if (owned && owned.length === 1) {
      unitResult = { kind: 'unit', orgUnitId: owned[0]!.orgUnitId, regionId: owned[0]!.regionId, ownerOid: current }
      placementCache.set(current, unitResult)
      break
    }
    // REGION: remember the FIRST region leader only; do NOT break (a unit may be above).
    if (!regionResult) {
      const rid = leaderMap.get(current)
      if (rid !== undefined) regionResult = { kind: 'region', regionId: rid }
    }
    if (path.includes(current)) break // cycle — no unit; regionResult (if any) stands
    path.push(current)
    if (!managerCache.has(current)) {
      // May throw on a non-404 Graph error → propagates (NOT cached).
      managerCache.set(current, await deps.getManager(current))
    }
    const manager = managerCache.get(current)!
    if (manager === null) break // top of chart
    current = manager.oid
    hops += 1
  }
  const result: ChainPlacement = cachedHit !== undefined ? cachedHit : (unitResult ?? regionResult ?? null)
  // Back-propagate the FINAL result to every visited intermediary (all share the chain
  // above the resolution point, so the outcome is the same for each). Mid-walk region hits
  // were never cached, so a unit found higher up correctly overrides them here.
  for (const p of path) placementCache.set(p, result)
  return result
}

/**
 * Resolve a placement for an unplaced (no cost-centre match) bill user. Order: a chain UNIT
 * wins (finest); else a directory-attribute→region rule OR a chain region; else null. The
 * attribute rules let each tenant key on whichever directory field is region-correlated on
 * their directory (companyName at Insight; department on AEUF-shaped tenants).
 */
export async function derivePlacement(
  dir: DirectoryUser,
  deps: {
    rules: RegionRuleSet
    unitOwnerMap: Map<string, OwnedUnit[]>
    leaderMap: Map<string, string>
    getManager: GetManager
    caches: ChainCaches
    maxHops?: number
  },
): Promise<PlacementDerivation> {
  const walkArgs = {
    unitOwnerMap: deps.unitOwnerMap,
    leaderMap: deps.leaderMap,
    getManager: deps.getManager,
    caches: deps.caches,
    maxHops: deps.maxHops,
  }
  let chain: ChainPlacement = null
  // 1. UNIT (practice) wins over everything, so we MUST walk first when any unit owners
  //    exist (a unit beats an attribute-mapped region). When there are no unit owners we
  //    skip this walk so an attribute-mapped user is not blocked by a transient Graph error.
  if (dir.oid && deps.unitOwnerMap.size > 0) {
    chain = await resolvePlacementViaManagerChain(dir.oid, walkArgs)
    if (chain?.kind === 'unit') {
      return { orgUnitId: chain.orgUnitId, regionId: chain.regionId, ownerOid: chain.ownerOid, via: 'unit' }
    }
  }
  // 2. directory-attribute → region rule, beats a chain region leader.
  const byAttr = mapAttributesToRegion(dir, deps.rules)
  if (byAttr) return { regionId: byAttr.regionId, via: 'attribute', attribute: byAttr.attribute, conflict: byAttr.conflict }
  // 3. chain region leader (run the walk now if step 1 was skipped).
  if (dir.oid && deps.leaderMap.size > 0) {
    if (chain === null) chain = await resolvePlacementViaManagerChain(dir.oid, walkArgs)
    if (chain?.kind === 'region') return { regionId: chain.regionId, via: 'manager' }
  }
  return { via: null }
}

/** Fresh per-run caches. Create once in the worker and thread through `derivePlacement`. */
export function makeChainCaches(): ChainCaches {
  return { managerCache: new Map(), placementCache: new Map() }
}
