/*
 * PATCH /api/v1/admin/regions/:id — rename a region (admin-region-lifecycle).
 *
 * platform-admin ONLY (same rationale as POST /regions: a region is a
 * cross-region object). global-finops and region admins 403.
 *
 * display_name is the ONLY editable field — `code` is IMMUTABLE. Region-scoped
 * queries hardcode region codes (e.g. 'apac'); changing a
 * region's code would silently break every region-scoped query that keys
 * on the code rather than the id. So we never accept a code change here.
 */
import { defineEventHandler, createError, getRouterParam, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'

const Body = z.object({
  display_name: z.string().min(1).max(120),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)

  const parsedId = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!parsedId.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid region id',
      data: {
        type: 'https://tokenscope.example.com/errors/invalid-input',
        title: 'Invalid region id',
        status: 400,
        detail: 'Expected a canonical UUID in the URL path.',
      },
    })
  }
  const regionId = parsedId.data

  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const before = await tx.execute<{ id: string; code: string; display_name: string }>(sql`
      SELECT id::text AS id, code, display_name
      FROM region WHERE id = ${regionId}::uuid LIMIT 1
    `)
    const beforeRow = [...before][0]
    if (!beforeRow) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Region not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Region not found',
          status: 404,
          detail: 'No region matches the supplied id.',
        },
      })
    }

    await tx.execute(sql`
      UPDATE region SET display_name = ${body.display_name} WHERE id = ${regionId}::uuid
    `)

    await recordAuditEvent(tx, {
      eventType: 'region-updated',
      actorTeammateId: caller.teammateId,
      subjectKind: 'region',
      subjectId: regionId,
      payload: {
        code: beforeRow.code,
        previous_display_name: beforeRow.display_name,
        display_name: body.display_name,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id: regionId, code: beforeRow.code, display_name: body.display_name }
  })
})
