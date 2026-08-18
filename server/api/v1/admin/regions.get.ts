/*
 * GET /api/v1/admin/regions — the region list for admin pickers (e.g. the
 * region-reassignment control). Region names aren't sensitive, so any admin /
 * global-finops (and platform-admin via the requireRole bypass) may read the
 * full list; the reassignment action itself is separately gated to org-wide
 * roles in users/[id]/region.patch.ts.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  // `region` carries no RLS policy, but the connection still carries the
  // caller's identity (docs/design/rls-enforcement.md: the lane decides, not
  // the table this particular query happens to name).
  const rows = await withRequestRls(event, (tx) =>
    tx.execute<{ id: string; code: string; display_name: string }>(sql`
      SELECT id::text AS id, code, display_name FROM region ORDER BY display_name, code
    `),
  )
  return { regions: [...rows] }
})
