/*
 * DELETE /api/v1/admin/department-map/{departmentLower} — remove a
 * department → region mapping (region derivation, mig 0068). admin /
 * global-finops.
 *
 * HARD delete: department_to_region is curated CONFIG, not history (unlike
 * the soft-revoked cou_owner / region_leader), so removing a mapping drops
 * the row. The path segment is the already-normalised department_lower key
 * (the PK) the GET list returns.
 */
import { defineEventHandler, createError, getRouterParam, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'

export default defineEventHandler(async (event) => {
  // Org-wide cross-region placement config → GLOBAL roles only (per design).
  const caller = await requireRole(event, 'global-finops', 'platform-admin')
  assertSameOrigin(event)

  const raw = getRouterParam(event, 'departmentLower')
  // The key is stored normalised (trim().lower()); normalise the path segment
  // the same way so a mixed-case URL still matches the stored row.
  const departmentLower = (raw ? decodeURIComponent(raw) : '').trim().toLowerCase()
  if (!departmentLower) {
    throw createError({ statusCode: 400, statusMessage: 'Missing department key' })
  }

  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const deleted = await tx.execute<{ department_lower: string; department: string }>(sql`
      DELETE FROM department_to_region
      WHERE department_lower = ${departmentLower}
      RETURNING department_lower, department
    `)
    const row = [...deleted][0]
    if (!row) {
      throw createError({ statusCode: 404, statusMessage: 'No mapping for this department' })
    }

    await recordAuditEvent(tx, {
      eventType: 'department-map-removed',
      actorTeammateId: caller.teammateId,
      subjectKind: 'department_to_region',
      subjectId: null,
      payload: {
        department: row.department,
        department_lower: row.department_lower,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { removed: true, department_lower: row.department_lower }
  })
})
