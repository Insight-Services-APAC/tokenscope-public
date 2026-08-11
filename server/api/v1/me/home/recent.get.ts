/*
 * GET /api/v1/me/home/recent?window=7|30|90 — Home's rolling-window "recent
 * spend" snapshot. Deliberately SEPARATE from /me/home (the month-to-date
 * budget/quota + tagging worklist): this endpoint carries NO budget/allocation
 * framing, only spend velocity over attribution_aggregate. That separation is
 * what lets the 7/30/90-day time controls be honest without pretending a
 * "7-day budget" exists.
 *
 * It lived at /me/usage/recent while serving Home, under a prefix that now
 * belongs to a DIFFERENT page. It moved with the page it serves, because a
 * rename that fixes the word on the screen and leaves it wrong in the route is
 * the same collision relocated rather than removed.
 *
 * Teammate-scoped via requireAuth + withRequestRls (the 0046 aggregate RLS
 * bridge applies under the non-owner role); reads the aggregate only.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { RecentWindowQuery, type RecentUsage } from '../../../../../shared/schemas/usage'
import { requireAuth } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { fetchDailySeries, fetchWindowTotals } from '../../../../usage/consumption'

export default defineEventHandler(async (event): Promise<RecentUsage> => {
  const session = await requireAuth(event)
  const { window } = await getValidatedQuery(event, (d) => RecentWindowQuery.parse(d))

  return await withRequestRls(event, async (tx) => {
    const [series, totals] = await Promise.all([
      fetchDailySeries(tx, 'teammate', session.teammateId, window),
      fetchWindowTotals(tx, 'teammate', session.teammateId, window),
    ])

    // Gap days are absent from the daily series → its length IS the active-day
    // count. cost_per_active_day is the intensity metric (null when idle).
    const activeDays = series.length
    const totalCost = totals.cost_usd
    const costPerActiveDay = activeDays > 0 ? (totalCost / activeDays).toFixed(2) : null

    return {
      window_days: window,
      total_cost_usd: totalCost.toFixed(2),
      total_tokens: totals.tokens,
      active_days: activeDays,
      cost_per_active_day: costPerActiveDay,
      series,
      by_model: totals.by_model,
    }
  })
})
