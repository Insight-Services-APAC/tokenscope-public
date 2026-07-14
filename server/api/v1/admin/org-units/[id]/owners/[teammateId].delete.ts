/*
 * DELETE /api/v1/admin/org-units/{id}/owners/{teammateId} — revoke a
 * cost-centre ownership (J4, mig 0048). Soft-revoke: the row keeps its
 * history (revoked_at/revoked_by); re-assignment later is a new row.
 * admin (region-scoped) / global-finops.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole, requireRegionScope } from '../../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../../auth/csrf'
import { withRequestRls } from '../../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../../db/audit'
import { requireUuidParam } from '../../../../../../utils/require-uuid-param'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'org unit id')
  const teammateId = requireUuidParam(event, 'teammateId', 'teammate id')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const ouRows = await tx.execute<{ region_id: string; display_name: string }>(sql`
      SELECT region_id::text AS region_id, display_name
      FROM org_unit WHERE id = ${id}::uuid
      LIMIT 1
    `)
    const ou = [...ouRows][0]
    if (!ou) {
      throw createError({ statusCode: 404, statusMessage: 'Org unit not found' })
    }
    await requireRegionScope(event, ou.region_id)

    const revoked = await tx.execute<{ id: string }>(sql`
      UPDATE cou_owner
      SET revoked_at = now(), revoked_by = ${caller.teammateId}::uuid
      WHERE org_unit_id = ${id}::uuid
        AND teammate_id = ${teammateId}::uuid
        AND revoked_at IS NULL
      RETURNING id::text AS id
    `)
    const row = [...revoked][0]
    if (!row) {
      throw createError({ statusCode: 404, statusMessage: 'No active ownership for this teammate' })
    }

    await recordAuditEvent(tx, {
      eventType: 'cou-owner-revoked',
      actorTeammateId: caller.teammateId,
      subjectKind: 'org_unit',
      subjectId: id,
      payload: { teammate_id: teammateId, org_unit_name: ou.display_name },
      ipAddress: ip,
      userAgent: ua,
    })

    return { revoked: true, teammate_id: teammateId }
  })
})
