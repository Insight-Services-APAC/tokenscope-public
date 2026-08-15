/*
 * DELETE /api/v1/admin/report-access/{id} — revoke a report-access grant
 * (mig 0129, replaces the three-mode admin dial's write side, task #19).
 * Soft-revoke: the row keeps its history (revoked_at/revoked_by), like
 * cou_owner (mig 0048) — a re-grant later is a new row.
 *
 * ORG-WIDE ONLY (A4): requireRole(event, 'global-finops').
 *
 * SELF-CLEAR GUARD (mig 0130): a `revoke-all` row is the "administer, no data"
 * denial. The revoked person KEEPS their org-wide admin role (a revoke removes
 * report DATA access, not admin power), so without this guard they would pass
 * requireRole here, list their own revoke, DELETE it and restore full
 * role-derived report access — defeating the separation entirely. Lifting your
 * OWN revoke therefore requires a DIFFERENT admin. (Clearing someone else's
 * revoke, or a positive grant, is unchanged — that is ordinary admin work.)
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { requireUuidParam } from '../../../../utils/require-uuid-param'
import { REPORT_ACCESS_REVOKE } from '../../../../../shared/auth/report-visibility'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'global-finops')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'report-access grant id')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // Read the target FIRST so a self-clear of one's own revoke is refused with a
    // clear 403 rather than being executed. `FOR UPDATE` holds the row so the
    // check and the soft-revoke are one atomic step.
    const target = [
      ...(await tx.execute<{ teammate_id: string; permission: string }>(sql`
        SELECT teammate_id::text AS teammate_id, permission
          FROM report_access_grant
         WHERE id = ${id}::uuid AND revoked_at IS NULL
         FOR UPDATE`)),
    ][0]
    if (target && target.permission === REPORT_ACCESS_REVOKE && target.teammate_id === caller.teammateId) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Cannot lift your own report-access revoke',
        data: {
          type: 'https://tokenscope.example.com/errors/forbidden',
          title: 'Cannot lift your own report-access revoke',
          status: 403,
          detail:
            'A report-access revoke can only be lifted by a different administrator — the "administer, no data" separation.',
        },
      })
    }

    const rows = await tx.execute<{
      id: string
      teammate_id: string
      permission: string
      granted_at: string
      expires_at: string | null
    }>(sql`
      UPDATE report_access_grant
         SET revoked_at = now(), revoked_by = ${caller.teammateId}::uuid
       WHERE id = ${id}::uuid AND revoked_at IS NULL
       RETURNING id::text AS id, teammate_id::text AS teammate_id, permission,
                 granted_at::text AS granted_at, expires_at::text AS expires_at
    `)
    const row = [...rows][0]
    if (!row) {
      throw createError({
        statusCode: 404,
        statusMessage: 'No active grant',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'No active grant',
          status: 404,
          detail: 'No active report-access grant matches that id.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'report-access-revoked',
      actorTeammateId: caller.teammateId,
      subjectKind: 'teammate',
      subjectId: row.teammate_id,
      payload: {
        before: { permission: row.permission, granted_at: row.granted_at, expires_at: row.expires_at },
        after: { revoked_at: new Date().toISOString() },
        context: { grant_id: row.id, teammate_id: row.teammate_id },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { revoked: true, id: row.id }
  })
})
