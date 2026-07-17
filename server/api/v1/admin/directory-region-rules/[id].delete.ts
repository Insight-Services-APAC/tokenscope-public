/*
 * DELETE /api/v1/admin/directory-region-rules/{id} — remove a directory→region
 * rule (mig 0089). HARD delete: rules are curated CONFIG, not history. GLOBAL
 * roles only.
 */
import { defineEventHandler, createError, getRouterParam, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'global-finops', 'platform-admin')
  assertSameOrigin(event)
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) throw createError({ statusCode: 400, statusMessage: 'Invalid rule id' })
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const deleted = await tx.execute<{ id: string; attribute: string; match_value: string }>(sql`
      DELETE FROM directory_region_rule
      WHERE id = ${id.data}::uuid
      RETURNING id::text AS id, attribute, match_value
    `)
    const row = [...deleted][0]
    if (!row) throw createError({ statusCode: 404, statusMessage: 'No such rule' })

    await recordAuditEvent(tx, {
      eventType: 'region-rule-removed',
      actorTeammateId: caller.teammateId,
      subjectKind: 'directory_region_rule',
      subjectId: row.id,
      payload: { attribute: row.attribute, match_value: row.match_value },
      ipAddress: ip,
      userAgent: ua,
    })

    return { removed: true, id: row.id }
  })
})
