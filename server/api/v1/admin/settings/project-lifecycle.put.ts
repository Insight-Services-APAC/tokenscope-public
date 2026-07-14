/*
 * PUT /api/v1/admin/settings/project-lifecycle — set the PLATFORM-default
 * project-lifecycle cadence (D9). Org-wide only: global-finops / platform-admin
 * (a region admin overrides only their own region, see
 * regions/[id]/project-lifecycle.put.ts). Audited.
 */
import { defineEventHandler, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { upsertLifecyclePolicy } from '../../../../db/project-lifecycle-policy'

const Body = z.object({
  grace_hours: z.number().int().min(0).max(168),
  warn_days: z.number().int().min(1).max(90),
})

export default defineEventHandler(async (event) => {
  // Org-wide admins only — the platform default is not a region admin's to set.
  const caller = await requireRole(event, 'global-finops')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    await upsertLifecyclePolicy(tx, {
      scopeType: 'platform',
      scopeId: null,
      graceHours: body.grace_hours,
      warnDays: body.warn_days,
      updatedBy: caller.teammateId,
    })
    await recordAuditEvent(tx, {
      eventType: 'project-lifecycle-policy-updated',
      actorTeammateId: caller.teammateId,
      subjectKind: 'platform',
      payload: { scope: 'platform', grace_hours: body.grace_hours, warn_days: body.warn_days },
      ipAddress: ip,
      userAgent: ua,
    })
    return { scope: 'platform', grace_hours: body.grace_hours, warn_days: body.warn_days }
  })
})
