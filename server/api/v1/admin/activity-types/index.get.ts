/*
 * GET /api/v1/admin/activity-types?region_id={regionId} — the region-admin
 * activity-tag management list (docs/design/activity-tagging-attribution.md).
 *
 * Lists the GLOBAL standard vocabulary (region_id IS NULL) PLUS the given
 * region's own additions (region_id = the region). A region `admin` is pinned
 * to their home region (requireRegionScope rejects another region); org-wide
 * roles (global-finops / platform-admin) may pass any region_id and default to
 * their own when none is supplied.
 *
 * Each row carries a derived `scope` ('global' | 'region') so the UI can render
 * the global/standard rows read-only for a region admin. Ordering: global
 * first, then sort_order, then lower(label) — matches the picker's order so the
 * management view reads the same way the developer sees it.
 *
 * NOTE: activity_type has no RLS policy (mig 0020), so scope is enforced
 * entirely at this app layer — the SQL filter below + requireRegionScope.
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'

const Query = z.object({
  region_id: z.string().uuid().optional(),
})

interface Row extends Record<string, unknown> {
  id: string
  region_id: string | null
  label: string
  is_standard: boolean
  sort_order: number
  is_active: boolean
  scope: 'global' | 'region'
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  const query = await getValidated(event, Query)

  // A region admin can only ever look at their own region; org-wide roles pick a
  // region or fall back to their own. region_id is forced to the caller's region
  // for a region admin so a stray query param can't widen the view.
  const isRegionBoundAdmin = caller.role === 'admin'
  const regionId = isRegionBoundAdmin
    ? caller.regionId
    : (query.region_id ?? caller.regionId)

  // Re-check region scope (no-op for org-wide roles; blocks a region admin who
  // somehow targets a foreign region).
  await requireRegionScope(event, regionId)

  const rows = await withRequestRls(event, async (tx) =>
    tx.execute<Row>(sql`
      SELECT id::text AS id,
             region_id::text AS region_id,
             label,
             is_standard,
             sort_order,
             is_active,
             CASE WHEN region_id IS NULL THEN 'global' ELSE 'region' END AS scope
        FROM activity_type
       WHERE region_id IS NULL OR region_id = ${regionId}::uuid
       ORDER BY (region_id IS NOT NULL), sort_order, lower(label)
    `),
  )

  return {
    region_id: regionId,
    activity_types: [...rows].map((r) => ({
      id: r.id,
      region_id: r.region_id,
      label: r.label,
      is_standard: r.is_standard,
      sort_order: Number(r.sort_order),
      is_active: r.is_active,
      scope: r.scope,
    })),
  }
})
