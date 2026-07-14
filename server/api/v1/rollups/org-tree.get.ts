/*
 * GET /api/v1/rollups/org-tree?[ouId=<root>] — hierarchical spend rollup of the caller's org
 * subtree (docs/design/org-tree-rollup.md). Each node carries its rolled-up MTD spend so a
 * manager / owner / leader sees each child bucket's subtotal + the all-up total, with drill-down.
 *
 * ROOT SELECTION
 *   - developer / manager (no ouId)         → their own org node (region-clamped).
 *   - admin / global-finops / platform-admin
 *     (no ouId)                             → a SYNTHETIC region root over their WHOLE region
 *                                             (regions are a forest of top-level BUs, so there
 *                                             is no single real root to anchor on). This is the
 *                                             "Phil sees Apps / Data / AI as buckets + the
 *                                             all-up" view.
 *   - any role with ?ouId=                  → that node, IFF it passes orgSubtreeScopePredicate
 *                                             (the IDOR + region guard); else 403.
 *
 * SECURITY: RLS is inert at runtime (app = table owner), so scope is embedded IN-QUERY. The
 * units + spend queries are clamped by BOTH region_id AND the root path — region_id alone is
 * load-bearing because org_unit paths are only unique PER REGION (org-units.post.ts), so a
 * `path <@ root.path` filter without a region clamp would leak a colliding path from another
 * region. Spend sums on v_complete_usage.org_unit_id (the point-in-time emit home — matches
 * the manager dashboard + what RLS scopes on), NOT the teammate's live home. v_complete_usage =
 * attribution_record (OTel) + unaccounted_usage (the API−OTel gap, mig 0076), so Copilot and other
 * un-emitted-but-billed usage appears here too (blended, no double-count). Holding nodes are
 * excluded from the tree and surfaced as the separate region-scoped "unplaced" line so the
 * all-up stays honest. Complete-usage lane (API truth), not the billed P&L.
 *
 * SCOPING NOTE: this endpoint is per-region. global-finops / platform-admin default to their
 * OWN region and pick any other via ?regionId= (the response carries `regionOptions` +
 * `selectedRegionId` for the UI selector); a region admin is hard-bound to its own region and
 * the param is ignored. The cross-region all-up lives in the finance rollup, not here.
 */
import { createError, defineEventHandler, getQuery } from 'h3'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { orgSubtreeScopePredicate } from '../../../auth/org-subtree-scope'
import { buildRollupTree, type RollupUnit, type UnitSpend } from '../../../utils/org-tree-rollup'
import { monthStartIso } from '../../../utils/period'
import { vendorCostSql } from '../../../../shared/usage/vendor'

const Query = z.object({
  ouId: z.string().uuid().optional(),
  // Region selector — honoured only for global-finops / platform-admin (cross-region roles);
  // a region admin is hard-bound to their own region and the param is ignored (finance-scope
  // contract). Ignored when ouId is set (the drilled node already fixes the region).
  regionId: z.string().uuid().optional(),
})

// Synthetic region-root id. The nil UUID never collides with a real org_unit (gen_random_uuid).
const SYNTHETIC_ROOT_ID = '00000000-0000-0000-0000-000000000000'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'developer', 'manager', 'admin', 'global-finops', 'platform-admin')
  const { ouId, regionId: requestedRegionId } = Query.parse(getQuery(event))
  const orgWide = caller.role === 'admin' || caller.role === 'global-finops' || caller.role === 'platform-admin'
  // Only the cross-region roles may pick a region; admin is locked to its own (finance-scope).
  const crossRegion = caller.role === 'global-finops' || caller.role === 'platform-admin'

  const monthStart = monthStartIso()

  return await withRequestRls(event, async (tx) => {
    // 1. Resolve the scope: a real node subtree, or the caller's whole region (synthetic root).
    type Scope =
      | { kind: 'node'; rootId: string; rootPath: string; regionId: string }
      | { kind: 'region'; regionId: string; regionName: string }
    let scope: Scope
    // Region picker payload (cross-region roles only). Computed up-front in the region branch so
    // `selectedRegionId` is guaranteed to appear in `regionOptions` (no phantom dropdown state).
    let regionOptions: { id: string; code: string; displayName: string }[] = []

    if (ouId) {
      // Explicit drill — the node must be a real, non-retired unit WITHIN the caller's scope
      // (the IDOR + cross-region guard). admin is region-clamped inside the predicate.
      const rows = await tx.execute<{ id: string; path: string; region_id: string }>(sql`
        SELECT id::text AS id, path::text AS path, region_id::text AS region_id
        FROM org_unit
        WHERE id = ${ouId}::uuid AND retired_at IS NULL AND unit_type <> 'holding'
          AND ${orgSubtreeScopePredicate('org_unit')}
        LIMIT 1`)
      // A holding node (__UNPLACED__) is not a drillable root — it's excluded from the tree and
      // surfaced as the unplaced line; resolving it would leave buildRollupTree without its root.
      const r = [...rows][0]
      if (!r) throw createError({ statusCode: 403, statusMessage: 'org unit not in your scope' })
      scope = { kind: 'node', rootId: r.id, rootPath: r.path, regionId: r.region_id }
    } else if (orgWide) {
      // Region-wide synthetic root. Cross-region roles (global-finops / platform-admin) may target
      // any region via ?regionId= and get the picker; admin is hard-bound to its own region.
      if (crossRegion) {
        const rgRows = await tx.execute<{ id: string; code: string; display_name: string }>(sql`
          SELECT id::text AS id, code, display_name FROM region
          WHERE code <> '__unassigned__' ORDER BY display_name`)
        regionOptions = [...rgRows].map((r) => ({ id: r.id, code: r.code, displayName: r.display_name }))
      }
      // Effective region: a validated explicit pick wins; else the caller's home if it's a real
      // selectable region; else the first real region — so a cross-region leader who happens to be
      // homed in the synthetic __unassigned__ region still lands on a real, selectable region and
      // selectedRegionId always appears in regionOptions. admin always uses its own region.
      let effectiveRegionId: string
      if (crossRegion && requestedRegionId) effectiveRegionId = requestedRegionId
      else if (crossRegion) effectiveRegionId = regionOptions.find((o) => o.id === caller.regionId)?.id ?? regionOptions[0]?.id ?? caller.regionId
      else effectiveRegionId = caller.regionId

      const rg = await tx.execute<{ display_name: string }>(sql`
        SELECT display_name FROM region WHERE id = ${effectiveRegionId}::uuid LIMIT 1`)
      const name = [...rg][0]?.display_name
      if (!name) throw createError({ statusCode: 404, statusMessage: 'region not found' })
      scope = { kind: 'region', regionId: effectiveRegionId, regionName: name }
    } else {
      // developer / manager default — their own org node (region-clamped so a colliding path
      // in another region can never be selected).
      const rows = await tx.execute<{ id: string; path: string; region_id: string }>(sql`
        SELECT id::text AS id, path::text AS path, region_id::text AS region_id
        FROM org_unit
        WHERE path = current_setting('app.user_org_path', true)::ltree
          AND region_id = ${caller.regionId}::uuid AND retired_at IS NULL AND unit_type <> 'holding'
        LIMIT 1`)
      const r = [...rows][0]
      if (!r) {
        // No normal org node (e.g. the caller sits on a holding node, whose own path won't match
        // a non-holding row) — empty tree rather than a buildRollupTree "root not loaded" throw.
        return { period: 'mtd', source: 'emitted', root: null, orphanCostUsd: 0, orphanTokens: 0, unplaced: null }
      }
      scope = { kind: 'node', rootId: r.id, rootPath: r.path, regionId: r.region_id }
    }

    // 2. Units + spend — region-clamped (load-bearing: paths are per-region-unique), holding
    //    nodes excluded (they surface as the separate "unplaced" line). For a node scope, also
    //    bound by the root path; for a region scope, the whole region.
    const unitScope: SQL = scope.kind === 'node'
      ? sql`region_id = ${scope.regionId}::uuid AND path <@ ${scope.rootPath}::ltree`
      : sql`region_id = ${scope.regionId}::uuid`
    const unitRows = await tx.execute<{
      id: string; parent_id: string | null; code: string
      display_name: string; unit_type: string; is_cost_owning_unit: boolean
    }>(sql`
      SELECT id::text AS id, parent_id::text AS parent_id,
             code, display_name, unit_type, is_cost_owning_unit
      FROM org_unit
      WHERE ${unitScope} AND retired_at IS NULL AND unit_type <> 'holding'
      ORDER BY path`)

    const spendScope: SQL = scope.kind === 'node'
      ? sql`ou.region_id = ${scope.regionId}::uuid AND ou.path <@ ${scope.rootPath}::ltree`
      : sql`ou.region_id = ${scope.regionId}::uuid`
    // Vendor split + per-node teammate ids are ADDITIVE conditional aggregates within the SAME
    // GROUP BY ar.org_unit_id — cardinality (and so the existing cost/tokens/emitters totals) is
    // unchanged. tool tokens are 'claude-code' / 'copilot-cli'; anything else (incl. NULL from a
    // reconciliation delta) buckets to 'other' so nothing vanishes from the vendor total.
    const vendorUsd = vendorCostSql('ar.cost_usd')
    const spendRows = await tx.execute<{
      org_unit_id: string; cost_usd: string; tokens: string; emitters: number
      claude_usd: string; copilot_usd: string; other_usd: string; teammate_ids: string[] | null
    }>(sql`
      SELECT ar.org_unit_id::text AS org_unit_id,
             COALESCE(SUM(ar.cost_usd), 0)::text AS cost_usd,
             COALESCE(SUM(ar.tokens), 0)::text   AS tokens,
             COUNT(DISTINCT ar.teammate_id)::int AS emitters,
             ${vendorUsd.claude}::text  AS claude_usd,
             ${vendorUsd.copilot}::text  AS copilot_usd,
             ${vendorUsd.other}::text AS other_usd,
             array_agg(DISTINCT ar.teammate_id::text) AS teammate_ids
      FROM v_complete_usage ar
      JOIN org_unit ou ON ou.id = ar.org_unit_id
      WHERE ar.ts_event >= ${monthStart}::timestamptz AND ${spendScope} AND ou.unit_type <> 'holding'
      GROUP BY ar.org_unit_id`)

    const units: RollupUnit[] = [...unitRows].map((u) => ({
      id: u.id, parentId: u.parent_id, code: u.code,
      displayName: u.display_name, unitType: u.unit_type, isCostOwningUnit: u.is_cost_owning_unit,
    }))

    // For a region scope, inject the synthetic root; every top-level BU (parent=null) re-parents
    // onto it inside buildRollupTree, so the forest rolls up under one "<region>" node.
    let rootId: string
    if (scope.kind === 'region') {
      rootId = SYNTHETIC_ROOT_ID
      units.unshift({
        id: rootId, parentId: null, code: '__REGION__',
        displayName: scope.regionName, unitType: 'region', isCostOwningUnit: false,
      })
    } else {
      rootId = scope.rootId
    }

    const spendByUnit = new Map<string, UnitSpend>(
      [...spendRows].map((s) => [s.org_unit_id, {
        costUsd: Number(s.cost_usd), tokens: Number(s.tokens), emitterCount: s.emitters,
        vendorUsd: { claude: Number(s.claude_usd), copilot: Number(s.copilot_usd), other: Number(s.other_usd) },
        teammateIds: s.teammate_ids ?? [],
      }]),
    )

    const { root: tree, orphanCostUsd, orphanTokens } = buildRollupTree(units, spendByUnit, rootId)

    // 3. Unplaced (region-scoped holding-node spend) — only on the region-wide default view, so
    //    a leader's region all-up is honest. Region-bound to the EFFECTIVE region (the selected
    //    one for cross-region roles), a uuid param, so no GUC cast can throw. Hidden on an explicit
    //    drill (it's region-level, not part of the drilled subtree) and for mid-tree manager/developer.
    let unplaced: { costUsd: number; tokens: number } | null = null
    if (scope.kind === 'region') {
      const upRows = await tx.execute<{ cost_usd: string; tokens: string }>(sql`
        SELECT COALESCE(SUM(ar.cost_usd), 0)::text AS cost_usd, COALESCE(SUM(ar.tokens), 0)::text AS tokens
        FROM v_complete_usage ar
        JOIN org_unit ou ON ou.id = ar.org_unit_id
        WHERE ar.ts_event >= ${monthStart}::timestamptz
          AND ou.unit_type = 'holding' AND ou.region_id = ${scope.regionId}::uuid`)
      const up = [...upRows][0]
      unplaced = { costUsd: Number(up?.cost_usd ?? 0), tokens: Number(up?.tokens ?? 0) }
    }

    // 4. Region selector payload — regionOptions was computed up-front (region branch). selectedRegionId
    //    is the region in view (always one of regionOptions for a cross-region role); null for a node scope.
    const selectedRegionId = scope.kind === 'region' ? scope.regionId : null

    return { period: 'mtd', source: 'emitted', root: tree, orphanCostUsd, orphanTokens, unplaced, selectedRegionId, regionOptions }
  })
})
