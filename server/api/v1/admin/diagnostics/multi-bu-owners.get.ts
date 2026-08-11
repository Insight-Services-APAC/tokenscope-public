/*
 * GET /api/v1/admin/diagnostics/multi-bu-owners — who owns more than one
 * Business Unit.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Owner ruling 2026-08-10: a person may own at most one BU. `owners.post.ts`
 * now refuses to create a second, but existing grants predate the rule and a
 * partial-unique index that cannot apply to the live database is not a
 * constraint, it is a failed deploy. So the order is: refuse new ones, REPORT
 * the old ones, clean up, then add the index.
 *
 * ── WHY IT MATTERS BEYOND TIDINESS ───────────────────────────────────────────
 * Multi-BU ownership is not inert. The manager-chain placement walk treats an
 * owner of more than one active cost-owning unit as AMBIGUOUS and skips them
 * (`region-derivation.ts` / `unit-owner-eligibility.ts`), so such an owner
 * places NOBODY through the chain — their reports pile up on the region default
 * BU instead, which is the dumping ground admin flags as "N of M do not belong
 * here". A rule about ownership is quietly a rule about placement.
 *
 * Read-only, admin/global-finops, region-scoped like every other admin read.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { orgSubtreeScopePredicate } from '../../../../auth/org-subtree-scope'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  const unbounded = caller.role === 'global-finops' || caller.role === 'platform-admin'

  return await withRequestRls(event, async (tx) => {
    const rows = [
      ...(await tx.execute<{
        teammate_id: string
        teammate: string
        email: string
        units: string
        unit_names: string[]
      }>(sql`
        SELECT t.id::text                                        AS teammate_id,
               COALESCE(NULLIF(t.display_name, ''), t.email)     AS teammate,
               t.email,
               COUNT(*)::text                                    AS units,
               array_agg(ou.display_name ORDER BY ou.display_name) AS unit_names
          FROM cou_owner co
          JOIN teammate t ON t.id = co.teammate_id
          JOIN org_unit ou ON ou.id = co.org_unit_id
         WHERE co.revoked_at IS NULL
           AND ou.retired_at IS NULL
           AND ${unbounded ? sql`TRUE` : orgSubtreeScopePredicate('ou')}
         GROUP BY t.id, t.display_name, t.email
        HAVING COUNT(*) > 1
         ORDER BY COUNT(*) DESC, teammate`)),
    ]

    return {
      // `clean` is the gate the index migration waits on — one field, so nobody
      // has to interpret an empty array as permission.
      clean: rows.length === 0,
      violations: rows.map((r) => ({
        teammateId: r.teammate_id,
        teammate: r.teammate,
        email: r.email,
        unitCount: Number(r.units),
        units: r.unit_names,
      })),
    }
  })
})
