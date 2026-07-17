/*
 * GET /api/v1/rollups/manager — manager rollup view (Journey 5 / Screen 3).
 *
 * Returns per-teammate + per-project rollups for the manager's org scope.
 * RLS handles the LTREE-subtree scope; the query joins
 * attribution_record → teammate / project for the current MTD.
 *
 * Epic 12 extension (MVP-Final): per-teammate top-project + velocity
 * signal (current week vs rolling 4-week mean, flagged at the
 * 'velocity.spike_threshold' governance dial — mig 0049, resolved once per
 * request for the caller's region); top-level Week-over-Week delta.
 */
import { createError, defineEventHandler, getQuery } from 'h3'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../auth/rbac'
import { isPlatformAdmin } from '../../../../shared/auth/roles'
import { withRequestRls } from '../../../db/request-rls'
import {
  GOV_VELOCITY_SPIKE_THRESHOLD,
  loadGovernanceSettingResolver,
} from '../../../utils/governance-settings'
import { monthStartIso as monthStartIsoFor } from '../../../utils/period'
import { managerScopePredicate } from '../../../auth/org-subtree-scope'

// Region selector — honoured only for the cross-region roles (global-finops / platform-admin);
// a region admin is hard-bound to its own region and the param is ignored (org-subtree-scope contract).
const Query = z.object({ regionId: z.string().uuid().optional() })

const VELOCITY_ROLLING_WEEKS = 4

interface PerTeammateRow extends Record<string, unknown> {
  teammate_id: string
  email: string
  display_name: string | null
  role: string | null
  total_tokens: string
  total_cost_usd: string
  top_project_code: string | null
  top_project_display_name: string | null
  current_week_usd: string
  rolling_mean_usd: string
  region_id: string
  delta_pct: string | null
}
interface PerProjectRow extends Record<string, unknown> {
  project_id: string
  code: string
  display_name: string
  total_tokens: string
  total_cost_usd: string
  allocation_usd: string | null
}
interface WowRow extends Record<string, unknown> {
  this_week_usd: string
  prior_week_usd: string
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'manager', 'admin', 'global-finops')
  const { regionId: requestedRegionId } = Query.parse(getQuery(event))
  // Cross-region roles may pick a region (or see all); admin is locked to its own.
  const crossRegion = caller.role === 'global-finops' || isPlatformAdmin(caller.role)
  const monthStartIso = monthStartIsoFor()

  return await withRequestRls(event, async (tx) => {
    // Spike-threshold dial (mig 0049): one snapshot per request, applied
    // per TEAMMATE region in the row mapping below (R2 F3). manager/admin are
    // single-region, but global-finops/platform-admin can span regions (all, or
    // a selected one) — a uniform caller-region threshold would flag out-of-region
    // teammates against the wrong dial, diverging from velocity-watch's per-region
    // inbox verdicts, so the threshold stays per-teammate-region.
    const thresholdFor = await loadGovernanceSettingResolver(tx, GOV_VELOCITY_SPIKE_THRESHOLD)

    // Region scope (org-subtree-scope model, RLS inert at runtime so it lives in-query):
    //   manager                          → their org subtree (region-clamped against path collision)
    //   admin                            → their OWN region, never another
    //   global-finops / platform-admin   → ALL regions, or a single one picked via ?regionId=
    // The cross-region roles also get the region list back for the UI selector; an unknown
    // requested region 404s. scopeClause() is applied to EVERY scoped query so they cannot diverge.
    let regionOptions: { id: string; code: string; display_name: string }[] = []
    let effectiveRegionId: string | null = null
    if (crossRegion) {
      const rgRows = await tx.execute<{ id: string; code: string; display_name: string }>(sql`
        SELECT id::text AS id, code, display_name FROM region WHERE code <> '__unassigned__' ORDER BY display_name`)
      regionOptions = [...rgRows].map((r) => ({ id: r.id, code: r.code, display_name: r.display_name }))
      if (requestedRegionId) {
        if (!regionOptions.some((r) => r.id === requestedRegionId)) {
          throw createError({ statusCode: 404, statusMessage: 'region not found' })
        }
        effectiveRegionId = requestedRegionId
      }
    }
    const selectedRegion: string | null = crossRegion ? (effectiveRegionId ?? 'all') : (caller.role === 'admin' ? caller.regionId : null)

    // Region scope (manager subtree / admin own-region / global selected-or-all) —
    // the shared managerScopePredicate (sibling of orgSubtreeScopePredicate; see
    // its doc for why they are NOT unified). Applied to EVERY scoped query so they
    // cannot diverge. `regionCol` / `subtreeCol` are code-constant column refs.
    const scopeClause = (regionCol: string, subtreeCol: string): SQL =>
      managerScopePredicate(caller, effectiveRegionId, regionCol, subtreeCol)
    // Scope teammates via scopeClause (manager subtree / admin region / global region-or-all).
    const perTeammate = await tx.execute<PerTeammateRow>(sql`
      WITH in_scope AS (
        SELECT id, email, display_name, org_unit_id, region_id
        FROM teammate
        WHERE is_active = TRUE
          AND ${scopeClause('region_id', 'org_unit_id')}
      ),
      mtd_per_teammate AS (
        SELECT t.id AS teammate_id,
               COALESCE(SUM(ar.tokens), 0)::text AS total_tokens,
               COALESCE(SUM(ar.cost_usd), 0)::text AS total_cost_usd
        FROM in_scope t
        LEFT JOIN v_complete_usage ar
          ON ar.teammate_id = t.id
         AND ar.ts_event >= ${monthStartIso}::timestamptz
        GROUP BY t.id
      ),
      top_project AS (
        SELECT teammate_id, project_code, project_display_name
        FROM (
          SELECT ar.teammate_id,
                 p.code AS project_code,
                 p.display_name AS project_display_name,
                 SUM(ar.cost_usd) AS total,
                 ROW_NUMBER() OVER (PARTITION BY ar.teammate_id ORDER BY SUM(ar.cost_usd) DESC) AS rn
          FROM v_complete_usage ar
          JOIN project p ON p.id = ar.project_id
          WHERE ar.teammate_id IN (SELECT id FROM in_scope)
            AND ar.ts_event >= ${monthStartIso}::timestamptz
          GROUP BY ar.teammate_id, p.code, p.display_name
        ) ranked
        WHERE rn = 1
      ),
      weekly AS (
        SELECT ar.teammate_id,
               date_trunc('week', ar.ts_event)::date AS week_start,
               SUM(ar.cost_usd) AS week_usd
        FROM v_complete_usage ar
        WHERE ar.teammate_id IN (SELECT id FROM in_scope)
          AND ar.ts_event >= date_trunc('week', NOW()) - (${VELOCITY_ROLLING_WEEKS} * INTERVAL '1 week')
        GROUP BY ar.teammate_id, date_trunc('week', ar.ts_event)
      ),
      velocity AS (
        SELECT teammate_id,
               COALESCE(SUM(week_usd) FILTER (WHERE week_start = date_trunc('week', NOW())::date), 0) AS current_week_usd,
               AVG(week_usd) FILTER (WHERE week_start < date_trunc('week', NOW())::date) AS rolling_mean_usd
        FROM weekly
        GROUP BY teammate_id
      )
      SELECT t.id::text AS teammate_id,
             t.email,
             t.display_name,
             NULL::text AS role,
             mpt.total_tokens,
             mpt.total_cost_usd,
             tp.project_code AS top_project_code,
             tp.project_display_name AS top_project_display_name,
             COALESCE(v.current_week_usd, 0)::text AS current_week_usd,
             COALESCE(v.rolling_mean_usd, 0)::text AS rolling_mean_usd,
             t.region_id::text AS region_id,
             CASE
               WHEN v.rolling_mean_usd IS NULL OR v.rolling_mean_usd = 0 THEN NULL
               ELSE ((v.current_week_usd - v.rolling_mean_usd) / v.rolling_mean_usd)::text
             END AS delta_pct
      FROM in_scope t
      LEFT JOIN mtd_per_teammate mpt ON mpt.teammate_id = t.id
      LEFT JOIN top_project tp ON tp.teammate_id = t.id
      LEFT JOIN velocity v ON v.teammate_id = t.id
      ORDER BY mpt.total_cost_usd::numeric DESC NULLS LAST
      LIMIT 100
    `)

    const perProject = await tx.execute<PerProjectRow>(sql`
      WITH proj_alloc AS (
        SELECT scope_id::text AS project_id,
               SUM(budget_usd)::text AS allocation_usd
        FROM allocation
        WHERE scope_type = 'project'
          AND allocation_kind IN ('baseline', 'top-up')
          AND effective @> ${monthStartIso}::timestamptz
        GROUP BY scope_id
      )
      SELECT p.id::text AS project_id,
             p.code,
             p.display_name,
             COALESCE(SUM(ar.tokens), 0)::text  AS total_tokens,
             COALESCE(SUM(ar.cost_usd), 0)::text AS total_cost_usd,
             pa.allocation_usd
      FROM project p
      LEFT JOIN attribution_record ar
        ON ar.project_id = p.id
       AND ar.ts_event >= ${monthStartIso}::timestamptz
      LEFT JOIN proj_alloc pa ON pa.project_id = p.id::text
      WHERE ${scopeClause('p.region_id', 'p.cost_owning_unit_id')}
      GROUP BY p.id, p.code, p.display_name, pa.allocation_usd
      ORDER BY SUM(ar.cost_usd) DESC NULLS LAST
      LIMIT 100
    `)

    // Week-over-week: this-week-to-date vs same days of prior week. Scoped via the same
    // scopeClause as in_scope (manager subtree / admin region / global region-or-all) — else
    // a manager's WoW KPI would sum the whole org. RLS is inert at runtime so it lives in-query.
    const wow = await tx.execute<WowRow>(sql`
      WITH this_week AS (
        SELECT COALESCE(SUM(ar.cost_usd), 0)::text AS this_week_usd
        FROM attribution_record ar
        WHERE ar.ts_event >= date_trunc('week', NOW())
          AND ${scopeClause('ar.region_id', 'ar.org_unit_id')}
      ),
      prior_week AS (
        SELECT COALESCE(SUM(ar.cost_usd), 0)::text AS prior_week_usd
        FROM attribution_record ar
        WHERE ar.ts_event >= date_trunc('week', NOW()) - INTERVAL '1 week'
          AND ar.ts_event <  date_trunc('week', NOW())
          AND ${scopeClause('ar.region_id', 'ar.org_unit_id')}
      )
      SELECT this_week.this_week_usd, prior_week.prior_week_usd
      FROM this_week, prior_week
    `)
    const wowRow = [...wow][0]
    const thisWeek = Number(wowRow?.this_week_usd ?? 0)
    const priorWeek = Number(wowRow?.prior_week_usd ?? 0)
    const wowDeltaPct = priorWeek > 0 ? (thisWeek - priorWeek) / priorWeek : null

    return {
      month_to_date: monthStartIso.slice(0, 7),
      per_teammate: [...perTeammate].map((r) => ({
        teammate_id: r.teammate_id,
        email: r.email,
        display_name: r.display_name,
        role: r.role,
        total_tokens: r.total_tokens,
        total_cost_usd: r.total_cost_usd,
        top_project_code: r.top_project_code,
        top_project_display_name: r.top_project_display_name,
        current_week_usd: Number(r.current_week_usd).toFixed(2),
        rolling_mean_usd: Number(r.rolling_mean_usd).toFixed(2),
        delta_pct: r.delta_pct === null ? null : Number(r.delta_pct),
        // Flag against the TEAMMATE's region dial (R2 F3) — matches the
        // velocity-watch inbox verdict for the same person and week.
        is_flagged: r.delta_pct !== null && Number(r.delta_pct) >= thresholdFor(r.region_id),
      })),
      per_project: [...perProject],
      wow: {
        this_week_usd: thisWeek.toFixed(2),
        prior_week_usd: priorWeek.toFixed(2),
        delta_pct: wowDeltaPct,
      },
      // Region selector payload: cross-region roles get the list + current selection
      // ('all' or a region id); admin gets its locked region; manager gets null (subtree view).
      region_options: regionOptions,
      selected_region: selectedRegion,
    }
  })
})
