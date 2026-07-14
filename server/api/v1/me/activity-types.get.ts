/*
 * GET /api/v1/me/activity-types — the hybrid activity vocabulary's suggestion
 * list for the tagging picker: global standard entries (region_id NULL) plus any
 * entries scoped to the caller's region. The value stored on an assignment is
 * free-form (the hybrid model — docs/design/activity-tagging-attribution.md), so
 * this is a suggestion source for the picker, NOT an allow-list.
 */
import { defineEventHandler } from 'h3'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { getActivityTypes } from '../../../utils/me-queries'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const activity_types = await withRequestRls(event, async (tx) =>
    getActivityTypes(tx, session.regionId, session.teammateId),
  )
  return { activity_types }
})
