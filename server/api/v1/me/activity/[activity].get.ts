/*
 * GET /api/v1/me/activity/{activity}?window=7|30|90 — the caller's tag/activity
 * drill-down: "how much did this activity cost me, on which models, across which
 * sessions." Teammate-scoped (requireAuth + withRequestRls); reads the ledger
 * for ONE activity over a rolling window (the sanctioned single-subject shape,
 * NOT a dashboard fan-out — see server/usage/activity-detail.ts).
 *
 * An activity the caller never tagged simply returns an empty breakdown (zeros
 * + empty lists) — activities are free-form labels, so there is no 404 "not
 * found" notion; the drawer renders its empty state.
 */
import { createError, defineEventHandler, getRouterParam, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { RecentWindowQuery, type ActivityDetail } from '../../../../../shared/schemas/usage'
import { requireAuth } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { fetchActivityDetail } from '../../../../usage/activity-detail'

export default defineEventHandler(async (event): Promise<ActivityDetail> => {
  const session = await requireAuth(event)
  // h3 already percent-decodes the router param (it decodes the path before
  // matching), so use it as-is — a second decodeURIComponent here would be a
  // double-decode that throws URIError (→ 500) on a label containing a literal '%'.
  const parsed = z.string().min(1).max(128).safeParse(getRouterParam(event, 'activity') ?? '')
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid activity' })
  }
  const { window } = await getValidatedQuery(event, (d) => RecentWindowQuery.parse(d))

  return await withRequestRls(event, (tx) => fetchActivityDetail(tx, session.teammateId, parsed.data, window))
})
