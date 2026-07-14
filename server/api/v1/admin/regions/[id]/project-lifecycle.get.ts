/*
 * GET /api/v1/admin/regions/:id/project-lifecycle — a region's
 * project-lifecycle cadence (D9): its override (or null = inherits), the
 * platform default, and the effective resolved values.
 */
import { defineEventHandler, getRouterParam, createError } from 'h3'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { getLifecyclePolicyRow, DEFAULT_LIFECYCLE_POLICY } from '../../../../../db/project-lifecycle-policy'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const parsed = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid region id' })
  const regionId = parsed.data

  return await withRequestRls(event, async (tx) => {
    await requireRegionScope(event, regionId)
    const override = await getLifecyclePolicyRow(tx, { scopeType: 'region', scopeId: regionId })
    const platform = (await getLifecyclePolicyRow(tx, { scopeType: 'platform' })) ?? DEFAULT_LIFECYCLE_POLICY
    const effective = override ?? platform
    return {
      override: override ? { grace_hours: override.graceHours, warn_days: override.warnDays } : null,
      platform: { grace_hours: platform.graceHours, warn_days: platform.warnDays },
      effective: { grace_hours: effective.graceHours, warn_days: effective.warnDays },
    }
  })
})
