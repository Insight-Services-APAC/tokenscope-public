/*
 * DELETE /api/v1/me/personal-subscription/{tool} — revoke my own declaration
 * for one tool (sets revoked_at; history retained, never deleted). Audited.
 */
import { defineEventHandler, createError, getRequestIP, getHeader, getRouterParam } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  assertSameOrigin(event)
  const tool = getRouterParam(event, 'tool')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return withRequestRls(event, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      UPDATE personal_subscription_declaration
      SET revoked_at = now()
      WHERE teammate_id = ${session.teammateId}::uuid AND tool = ${tool} AND revoked_at IS NULL
      RETURNING id::text AS id
    `)
    const row = rows[0]
    if (!row) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Personal subscription declaration not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Personal subscription declaration not found',
          status: 404,
          detail: 'No active declaration for that tool.',
        },
      })
    }
    await recordAuditEvent(tx, {
      eventType: 'personal-subscription-revoked',
      actorTeammateId: session.teammateId,
      subjectKind: 'personal_subscription_declaration',
      subjectId: row.id,
      payload: { tool },
      ipAddress: ip,
      userAgent: ua,
    })
    return { id: row.id, revoked: true }
  })
})
