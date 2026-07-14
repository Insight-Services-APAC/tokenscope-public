/*
 * GET /api/v1/admin/org-units?region={regionId} — LTREE-shaped tree
 * of org units for the admin org-units tab (design-notes §Screen 5).
 *
 * Returns rows in path order; the client renders the tree by
 * walking depth (nlevel of the LTREE path). Each row carries
 * inline counts of teammates and projects so the row label can
 * read "Practice Sigma · 32 teammates · 5 projects".
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'

const Query = z.object({
  region: z.string().uuid(),
})

interface NodeRow extends Record<string, unknown> {
  id: string
  parent_id: string | null
  path: string
  depth: string
  code: string
  display_name: string
  unit_type: string
  is_cost_owning_unit: boolean
  teammate_count: string
  project_count: string
  owners: Array<{ teammate_id: string; display_name: string | null; email: string }> | null
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const query = await getValidated(event, Query)
  await requireRegionScope(event, query.region)

  const rows = await withRequestRls(event, async (tx) =>
    tx.execute<NodeRow>(sql`
      SELECT ou.id::text AS id,
             ou.parent_id::text AS parent_id,
             ou.path::text AS path,
             nlevel(ou.path)::text AS depth,
             ou.code,
             ou.display_name,
             ou.unit_type,
             ou.is_cost_owning_unit,
             COALESCE(tm.cnt, 0)::text AS teammate_count,
             COALESCE(pr.cnt, 0)::text AS project_count,
             own.owners
      FROM org_unit ou
      LEFT JOIN (
        SELECT org_unit_id, COUNT(*) AS cnt FROM teammate WHERE is_active = TRUE GROUP BY org_unit_id
      ) tm ON tm.org_unit_id = ou.id
      LEFT JOIN (
        SELECT cost_owning_unit_id, COUNT(*) AS cnt FROM project GROUP BY cost_owning_unit_id
      ) pr ON pr.cost_owning_unit_id = ou.id
      LEFT JOIN (
        -- Active CC owners (J4, mig 0048) — drives the owner chips +
        -- assignment UI on the Cost centres tab.
        SELECT co.org_unit_id,
               jsonb_agg(jsonb_build_object(
                 'teammate_id', t.id::text,
                 'display_name', t.display_name,
                 'email', t.email
               ) ORDER BY t.display_name NULLS LAST) AS owners
        FROM cou_owner co
        JOIN teammate t ON t.id = co.teammate_id
        WHERE co.revoked_at IS NULL
        GROUP BY co.org_unit_id
      ) own ON own.org_unit_id = ou.id
      WHERE ou.region_id = ${query.region}::uuid
        AND ou.retired_at IS NULL
      ORDER BY ou.path
    `),
  )

  return {
    nodes: [...rows].map((r) => ({
      id: r.id,
      parent_id: r.parent_id,
      path: r.path,
      depth: Number(r.depth),
      code: r.code,
      display_name: r.display_name,
      unit_type: r.unit_type,
      is_cost_owning_unit: r.is_cost_owning_unit,
      teammate_count: Number(r.teammate_count),
      project_count: Number(r.project_count),
      owners: r.owners ?? [],
    })),
  }
})
