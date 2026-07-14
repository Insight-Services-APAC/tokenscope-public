/*
 * GET /api/v1/admin/settings/project-lifecycle — the platform-default
 * project-lifecycle cadence (grace_hours / warn_days, D9). Readable by any
 * admin so region screens can show the inherited default they'd override.
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { getLifecyclePolicyRow, DEFAULT_LIFECYCLE_POLICY } from '../../../../db/project-lifecycle-policy'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  return await withRequestRls(event, async (tx) => {
    const platform = (await getLifecyclePolicyRow(tx, { scopeType: 'platform' })) ?? DEFAULT_LIFECYCLE_POLICY
    return { platform: { grace_hours: platform.graceHours, warn_days: platform.warnDays } }
  })
})
