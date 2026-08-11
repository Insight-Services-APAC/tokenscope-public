/*
 * GET /api/v1/admin/report-access — list report-access grants (mig 0129,
 * replaces the three-mode admin dial's read side, task #19).
 *
 * ORG-WIDE ONLY (A4): `requireRole(event, 'global-finops')` — platform-admin
 * passes any requireRole gate (shared/auth/roles.ts:28); no 'admin' read
 * access and no re-narrow step, unlike the retired report-visibility.get.ts
 * (a REGION admin could read that org-wide dial; a per-teammate grant list is
 * a narrower, more sensitive surface and stays org-wide end to end).
 *
 * Rows INCLUDE expired-but-not-revoked grants (A5's re-grant-deadlock fix):
 * an expired row still names WHO held WHAT, so hiding it would make the
 * expiry invisible until an admin tried to re-grant and hit the unique index
 * with no explanation. `status` distinguishes the two so the UI can show it
 * without a second date computation. Active rows lead, each group ordered by
 * `granted_at DESC`.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'

interface Row extends Record<string, unknown> {
  id: string
  teammate_id: string
  display_name: string | null
  email: string
  role: string
  permission: string
  granted_by: string | null
  granted_by_name: string | null
  granted_at: string
  expires_at: string | null
  is_expired: boolean
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'global-finops')

  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<Row>(sql`
      SELECT rag.id::text AS id,
             rag.teammate_id::text AS teammate_id,
             t.display_name AS display_name,
             t.email AS email,
             t.role AS role,
             rag.permission AS permission,
             rag.granted_by::text AS granted_by,
             gb.display_name AS granted_by_name,
             rag.granted_at::text AS granted_at,
             rag.expires_at::text AS expires_at,
             (rag.expires_at IS NOT NULL AND rag.expires_at <= now()) AS is_expired
        FROM report_access_grant rag
        JOIN teammate t ON t.id = rag.teammate_id
        LEFT JOIN teammate gb ON gb.id = rag.granted_by
       WHERE rag.revoked_at IS NULL
       ORDER BY is_expired ASC, rag.granted_at DESC
    `)

    return {
      grants: [...rows].map((r) => ({
        id: r.id,
        teammate_id: r.teammate_id,
        display_name: r.display_name,
        email: r.email,
        role: r.role,
        permission: r.permission,
        granted_by: r.granted_by,
        granted_by_name: r.granted_by_name,
        granted_at: r.granted_at,
        expires_at: r.expires_at,
        status: r.is_expired ? ('expired' as const) : ('active' as const),
      })),
    }
  })
})
