/*
 * Placement derivation for cost-centre-unplaced users (mig 0068 region + the unit/practice
 * extension; docs/design/org-entra-region-derivation.md + manager-chain-unit-placement.md).
 * PRECEDENCE, highest first (derivePlacement below):
 *   0. UNIT RULE — a curated directory-attribute rule naming a cost-owning unit
 *      (mig 0112). An explicit admin statement outranks an inferred chain walk.
 *   1. UNIT (practice): the nearest chain ancestor who is an active cou_owner of EXACTLY
 *      ONE cost-owning unit → place in that unit (Entra is the org truth → chargeable).
 *   2. REGION RULE — a curated attribute rule naming a region → region holding node.
 *   3. REGION: else the nearest ancestor who is a configured region_leader → region holding.
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
import type { DerivedManager, PlacementDerivation } from './placement-service'
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
 * What ONE curated rule places a matching teammate into.
 *
 * `orgUnitId` is the mig-0112 extension: a rule may name a cost-owning UNIT
 * rather than only a region. It is the SAME rule, the same matcher and the same
 * table — only the target is finer. `regionId` is always populated (for a unit
 * rule it is the unit's own region, held true by the composite FK), so every
 * existing region-shaped reader keeps working unchanged.
 */
export interface RuleTarget {
  regionId: string
  /** NULL = region rule. Non-null = place into this cost-owning unit. */
  orgUnitId: string | null
}

/**
 * The curated directory rules, pre-indexed for lookup. `exact` is a nested
 * attribute→value→target map (O(1) hits, no string-composite key); the `prefix`
 * list is scanned longest-value-first so the most specific prefix wins.
 * Built by the store's loadDirectoryRegionRules().
 */
export interface RegionRuleSet {
  exact: Map<RegionAttributeKey, Map<string, RuleTarget>>
  prefix: Array<{ attribute: RegionAttributeKey; value: string; target: RuleTarget }>
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
  /** The matched rule's UNIT target (mig 0112), or null for a region rule. */
  orgUnitId: string | null
  attribute: RegionAttributeKey
  /** True if a LOWER-precedence attribute also matched but to a DIFFERENT TARGET
   *  — another region, or another unit, or a region where this one names a unit
   *  (a misconfiguration worth surfacing; the highest-precedence match wins). */
  conflict: boolean
}

/**
 * Resolve a placement target from the directory rules, trying attributes in
 * catalog PRECEDENCE order (companyName → … → department). Exact match first,
 * then prefix. Highest-precedence hit wins; a divergent lower hit is flagged as
 * a conflict. Returns null when no attribute matches (→ manager-walk / global
 * fallback).
 *
 * `conflict` compares the COMPLETE TARGET — region AND unit. Comparing regions
 * alone reported "no conflict" for two rules that match one person and name two
 * DIFFERENT cost centres in the same region, so the broad-catalogue rule quietly
 * won and the narrow one an admin had just written did nothing. That is not "an
 * ordering the precedence catalog decides": which cost centre a person's spend
 * charges is the decision this feature exists to make, and two rules disagreeing
 * about it is a misconfiguration in exactly the way two regions is. A rule naming
 * a unit versus one naming only the region is a divergence too — one places, the
 * other does not.
 *
 * The highest-precedence hit still WINS; `conflict` is how the divergence is
 * surfaced rather than swallowed (placement-sync counts it, and the derivation
 * carries it out on PlacementDerivation.conflict).
 */
export function mapAttributesToRegion(
  dir: DirectoryUser,
  rules: RegionRuleSet = EMPTY_RULE_SET,
): AttributeMatch | null {
  const hits: Array<{ attribute: RegionAttributeKey; target: RuleTarget }> = []
  for (const attr of REGION_ATTRIBUTE_KEYS) {
    const norm = normalizeMatchValue(dirAttrValue(dir, attr))
    if (!norm) continue
    let target = rules.exact.get(attr)?.get(norm)
    if (!target) {
      const pfx = rules.prefix.find((p) => p.attribute === attr && norm.startsWith(p.value))
      if (pfx) target = pfx.target
    }
    if (target) hits.push({ attribute: attr, target })
  }
  if (hits.length === 0) return null
  const winner = hits[0]!
  const conflict = hits.some(
    (h) =>
      h.target.regionId !== winner.target.regionId || h.target.orgUnitId !== winner.target.orgUnitId,
  )
  return {
    regionId: winner.target.regionId,
    orgUnitId: winner.target.orgUnitId,
    attribute: winner.attribute,
    conflict,
  }
}

/**
 * THE rule that decides whether a cou_owner can be a placement target at all.
 *
 * An owner of exactly one active cost-owning unit resolves; an owner of two or
 * more is AMBIGUOUS — the walk cannot tell which of their units a report belongs
 * to, so it skips them entirely and keeps climbing. Such an owner places nobody,
 * on either unit, and on screen looks identical to one that works.
 *
 * Exported because the ADMIN SURFACE has to warn about exactly this, and a second
 * predicate written to describe the same condition is a warning that drifts from
 * the behaviour it describes. The walk below calls this function; so does
 * server/api/v1/admin/org-units.get.ts. There is one condition, in one place.
 *
 * Both read the SAME map (`PlacementStore.loadActiveUnitOwners`), so "active",
 * "cost-owning", "not retired" and "has a real Entra oid" are also one definition
 * rather than a re-derived approximation.
 */
export function resolvesToSingleUnit(owned: OwnedUnit[] | undefined): owned is [OwnedUnit] {
  return resolvesToSingleUnitCount(owned?.length ?? 0)
}

/**
 * The SAME rule, expressed over a count rather than the rows.
 *
 * The admin org-unit tree needs the ambiguity verdict for owners whose second
 * unit may sit in a region the caller cannot read, so it reads aggregate counts
 * from the `owner_active_unit_counts()` SECURITY DEFINER function (mig 0111)
 * rather than the rows. It must reach the same verdict as the walk, so both go
 * through this one predicate — `resolvesToSingleUnit` above is now a thin
 * wrapper over it. Changing the rule in one place changes it in both, which is
 * the property the warning depends on: a chip that claimed a behaviour the walk
 * does not have would be worse than no chip.
 */
export function resolvesToSingleUnitCount(unitCount: number): boolean {
  return unitCount === UNAMBIGUOUS_OWNER_UNIT_COUNT
}

/**
 * How many active cost-owning units an owner may hold and still be a placement
 * target. Named, and exported, because SQL readers need the same number:
 * server/reconciliation/unit-owner-eligibility.ts folds the ambiguity rule into a
 * query, and a literal `1` written there would be the second definition this
 * whole arrangement exists to avoid.
 */
export const UNAMBIGUOUS_OWNER_UNIT_COUNT = 1

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
    if (resolvesToSingleUnit(owned)) {
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
  /*
   * The attribute match is resolved ONCE, up front, because it can now answer at
   * two different precedence levels: a UNIT rule outranks the chain walk (step 0)
   * while a REGION rule still sits below it (step 2). Matching twice would be two
   * evaluations of one rule set that could disagree after an edit between them.
   */
  const byAttr = mapAttributesToRegion(dir, deps.rules)

  /*
   * 0. A UNIT RULE BEATS THE MANAGER CHAIN (spec C5, owner decision O1).
   *
   * An admin writing "department = X ⇒ cost centre U" is making an explicit
   * statement about their org; the chain walk is an INFERENCE from reporting
   * lines. The explicit statement wins — which is also how region rules already
   * behave (step 2 beats step 3), so the two rule kinds agree rather than
   * ordering themselves differently for no reason a user could predict.
   *
   * It sits at the same level as the cost-centre-code match in
   * provisionAndPlace, which is evaluated before this function is called at all.
   *
   * No manager oid is reported here: nothing walked, so nothing knows it. The
   * caller distinguishes "we never asked" from "asked, top of chart".
   */
  if (byAttr?.orgUnitId) {
    return {
      orgUnitId: byAttr.orgUnitId,
      regionId: byAttr.regionId,
      via: 'unit-rule',
      attribute: byAttr.attribute,
      conflict: byAttr.conflict,
    }
  }

  let chain: ChainPlacement = null
  let walked = false
  // 1. UNIT (practice) wins over a region, so we MUST walk before step 2 when any unit
  //    owners exist (a chain unit beats an attribute-mapped region). When there are no
  //    unit owners we skip this walk so an attribute-mapped user is not blocked by a
  //    transient Graph error.
  if (dir.oid && deps.unitOwnerMap.size > 0) {
    chain = await resolvePlacementViaManagerChain(dir.oid, walkArgs)
    walked = true
    if (chain?.kind === 'unit') {
      return {
        orgUnitId: chain.orgUnitId,
        regionId: chain.regionId,
        ownerOid: chain.ownerOid,
        via: 'unit',
        manager: directManagerFrom(deps.caches, dir.oid),
      }
    }
  }
  // 2. directory-attribute → region rule, beats a chain region leader.
  if (byAttr) {
    return {
      regionId: byAttr.regionId,
      via: 'attribute',
      attribute: byAttr.attribute,
      conflict: byAttr.conflict,
      manager: walked && dir.oid ? directManagerFrom(deps.caches, dir.oid) : undefined,
    }
  }
  // 3. chain region leader (run the walk now if step 1 was skipped).
  if (dir.oid && deps.leaderMap.size > 0) {
    if (chain === null) {
      chain = await resolvePlacementViaManagerChain(dir.oid, walkArgs)
      walked = true
    }
    if (chain?.kind === 'region') {
      return { regionId: chain.regionId, via: 'manager', manager: directManagerFrom(deps.caches, dir.oid) }
    }
  }
  return { via: null, manager: walked && dir.oid ? directManagerFrom(deps.caches, dir.oid) : undefined }
}

/**
 * The teammate's OWN manager, read from the per-run cache the walk populates.
 *
 * CACHE-ONLY, never a fetch — that is the whole design. C9 needs each occupant's
 * direct manager to group "who does this person actually report to", and the very
 * first hop of the chain walk already asked Graph that exact question. Reading it
 * back costs nothing and adds no new failure mode; issuing a fetch here would add
 * a Graph call (and a throw path) to a derivation that had already decided.
 *
 * `undefined` = the walk never ran for this oid, so we do not know and must not
 * overwrite what a previous run captured. `null` = we asked and they are the top
 * of the chart. The two are different facts and the snapshot keeps them apart.
 */
function directManagerFrom(caches: ChainCaches, oid: string): DerivedManager | undefined {
  if (!caches.managerCache.has(oid)) return undefined
  const edge = caches.managerCache.get(oid) ?? null
  return { oid: edge?.oid ?? null, email: edge?.email ?? null }
}

/** Fresh per-run caches. Create once in the worker and thread through `derivePlacement`. */
export function makeChainCaches(): ChainCaches {
  return { managerCache: new Map(), placementCache: new Map() }
}
