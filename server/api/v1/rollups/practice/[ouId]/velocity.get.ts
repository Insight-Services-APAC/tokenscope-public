/*
 * GET /api/v1/rollups/practice/{ouId}/velocity — velocity baseline
 * signal for the Signal column on the manager rollup
 * (design-notes §Screen 3 + mvp-final-epic.md §Epic 12).
 *
 * Compute-on-read (preflight decision recorded in
 * docs/build/mvp-final-evidence/epic-12-preflight.md §5):
 *   - Bucket attribution_record by ISO-week (`date_trunc('week', ts_event)`)
 *   - Compute the 4-week rolling mean cost-per-teammate-per-week
 *   - Flag the current week as "above typical" when its cost exceeds the
 *     rolling mean by the 'velocity.spike_threshold' governance dial
 *     (mig 0049, resolved once per request for the caller's region;
 *     platform default 25%)
 *
 * Scope: the `ouId` path param is the focus OU. For non-admins the
 * result is intersected with the caller's own org subtree
 * (current_setting('app.user_org_path')), so passing an ancestor/root
 * ouId cannot widen the result beyond the caller's authority — a manager
 * who supplies the org root still only sees their own subtree. Admin /
 * global-finops are unbounded. (RLS would enforce the same once the
 * non-owner DB role lands; until then this app-level clamp is the live
 * gate — see server/auth/allocation-scope.ts for the same rationale.)
 */
import { createError, defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../../auth/rbac'
import { orgSubtreeScopePredicate } from '../../../../../auth/org-subtree-scope'
import { withRequestRls } from '../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import {
  GOV_VELOCITY_SPIKE_THRESHOLD,
  resolveGovernanceSetting,
} from '../../../../../utils/governance-settings'

interface VelocityRow extends Record<string, unknown> {
  teammate_id: string
  email: string
  display_name: string | null
  current_week_usd: string
  rolling_mean_usd: string
  delta_pct: string | null
  is_flagged: boolean
}

const ROLLING_WEEKS = 4

export default defineEventHandler(async (event) => {
  await requireRole(event, 'manager', 'admin', 'global-finops')
  const ouId = requireUuidParam(event, 'ouId')

  // Spike-threshold dial (mig 0049): resolved for the PRACTICE's region
  // (R1 F3 — the subject org-unit decides the bar, not the viewer; a
  // global role inspecting another region must see that region's dial,
  // matching velocity-watch's per-teammate-region inbox verdicts).
  // Echoed in the response so the UI can label the bar it flags against.
  const { rows, flagThreshold } = await withRequestRls(event, async (tx) => {
    // Authorize the FOCUS ou itself (anti-IDOR, sg-H3 leak fix): a region admin passing
    // a foreign-region ouId must 403, NOT silently read that region. The old clause
    // unbounded admins by role only (`role IN ('admin','global-finops')`), but org paths
    // are unique only per-region — so a foreign ouId leaked another region's per-teammate
    // spend. orgSubtreeScopePredicate region-clamps admins exactly like its siblings
    // (practice/[ouId].get.ts / managerScopePredicate); global-finops/platform-admin stay
    // unbounded. A non-existent OR out-of-scope ouId does not resolve → 403.
    const focusRows = await tx.execute<{ region_id: string }>(sql`
      SELECT region_id::text AS region_id FROM org_unit
      WHERE id = ${ouId}::uuid AND ${orgSubtreeScopePredicate('org_unit')}
      LIMIT 1
    `)
    const focus = [...focusRows][0]
    if (!focus) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: {
          type: 'https://tokenscope.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'org unit not in your scope',
        },
      })
    }
    const threshold = await resolveGovernanceSetting(
      tx,
      GOV_VELOCITY_SPIKE_THRESHOLD,
      // The subject org-unit decides the bar (R1 F3). Now that a foreign region 403s
      // above, this is the caller's own region for an admin, any region for global.
      focus.region_id,
    )
    const result = await tx.execute<VelocityRow>(sql`
      WITH ouscope AS (
        -- Region-clamp the subtree expansion too (not just the focus check): paths are
        -- unique per-region, so a bare \`path <@ focus.path\` could pull colliding paths
        -- from ANOTHER region. orgSubtreeScopePredicate wraps the region clamp around it.
        SELECT ou.id FROM org_unit ou
        WHERE ou.path <@ (SELECT path FROM org_unit WHERE id = ${ouId}::uuid)
          AND ${orgSubtreeScopePredicate('ou')}
      ),
      weekly AS (
        SELECT t.id AS teammate_id,
               t.email,
               t.display_name,
               date_trunc('week', ar.ts_event)::date AS week_start,
               SUM(ar.cost_usd) AS week_usd
        FROM teammate t
        JOIN attribution_record ar ON ar.teammate_id = t.id
        WHERE t.org_unit_id IN (SELECT id FROM ouscope)
          AND ar.ts_event >= date_trunc('week', NOW()) - (${ROLLING_WEEKS} * INTERVAL '1 week')
        GROUP BY t.id, t.email, t.display_name, date_trunc('week', ar.ts_event)
      ),
      pivoted AS (
        SELECT teammate_id, email, display_name,
               SUM(week_usd) FILTER (WHERE week_start = date_trunc('week', NOW())::date) AS current_week_usd,
               AVG(week_usd) FILTER (WHERE week_start < date_trunc('week', NOW())::date) AS rolling_mean_usd
        FROM weekly
        GROUP BY teammate_id, email, display_name
      )
      SELECT teammate_id::text AS teammate_id,
             email,
             display_name,
             COALESCE(current_week_usd, 0)::text AS current_week_usd,
             COALESCE(rolling_mean_usd, 0)::text AS rolling_mean_usd,
             CASE
               WHEN rolling_mean_usd IS NULL OR rolling_mean_usd = 0 THEN NULL
               ELSE ((current_week_usd - rolling_mean_usd) / rolling_mean_usd)::text
             END AS delta_pct,
             CASE
               WHEN rolling_mean_usd IS NULL OR rolling_mean_usd = 0 THEN FALSE
               WHEN current_week_usd IS NULL THEN FALSE
               ELSE (current_week_usd - rolling_mean_usd) / rolling_mean_usd >= ${threshold}
             END AS is_flagged
      FROM pivoted
      ORDER BY is_flagged DESC, current_week_usd DESC NULLS LAST
    `)
    return { rows: result, flagThreshold: threshold }
  })

  return {
    ou_id: ouId,
    threshold: flagThreshold,
    rolling_weeks: ROLLING_WEEKS,
    teammates: [...rows].map((r) => ({
      teammate_id: r.teammate_id,
      email: r.email,
      display_name: r.display_name,
      current_week_usd: Number(r.current_week_usd).toFixed(2),
      rolling_mean_usd: Number(r.rolling_mean_usd).toFixed(2),
      delta_pct: r.delta_pct === null ? null : Number(r.delta_pct),
      is_flagged: r.is_flagged,
    })),
  }
})
