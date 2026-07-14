/*
 * DELETE /api/v1/admin/regions/:id/project-lifecycle — clear a region override
 * so the region reverts to the platform default (D9). Region admin scoped to
 * their own region; org-wide admins any region. Audited. 404 if no override.
 */
import { defineEventHandler, getRouterParam, createError, getRequestIP, getHeader } from 'h3'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { clearRegionLifecyclePolicy } from '../../../../../db/project-lifecycle-policy'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const parsed = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid region id' })
  const regionId = parsed.data
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    await requireRegionScope(event, regionId)
    const cleared = await clearRegionLifecyclePolicy(tx, regionId)
    if (!cleared) {
      throw createError({
        statusCode: 404,
        statusMessage: 'No region override to clear',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'No region override',
          status: 404,
          detail: 'This region has no project-lifecycle override; it already inherits the platform default.',
        },
      })
    }
    await recordAuditEvent(tx, {
      eventType: 'project-lifecycle-policy-cleared',
      actorTeammateId: caller.teammateId,
      subjectKind: 'region',
      subjectId: regionId,
      payload: { scope: 'region', region_id: regionId },
      ipAddress: ip,
      userAgent: ua,
    })
    return { scope: 'region', region_id: regionId, cleared: true }
  })
})
