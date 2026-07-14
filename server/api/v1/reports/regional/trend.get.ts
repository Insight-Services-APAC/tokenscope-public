/*
 * GET /api/v1/reports/regional/trend?month&region&ou? — the day-grain,
 * vendor-stacked usage trend for the Regional scope (build-design §2/§3/§4).
 *
 * Same lane (`v_complete_usage`) + scope as `/reports/regional`; per-day split
 * into Claude / Copilot / Other vendors (the ChartsStackedBars series). Lane
 * firewall: no `attribution_record` / raw `actual_spend` (§7(7)).
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import {
  resolveRegionalScope,
  fetchRegionalTrend,
  fetchRegionalChargebackTrend,
} from '../../../../reporting/regional'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  region: z.string().uuid().optional(),
  ou: z.string().uuid().optional(),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(
    event,
    'developer',
    'manager',
    'admin',
    'global-finops',
    'platform-admin',
  )
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  // Month OR custom from/to window so the DateRangeControl re-windows the trend.
  // Month mode is byte-identical to the old path.
  const win = resolveReportWindow(query)
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))

  return await withRequestRls(event, async (tx) => {
    const scope = await resolveRegionalScope(tx, caller, { region: query.region, ou: query.ou })
    const { series, windowDays } = await fetchRegionalTrend(tx, scope, win)
    // §B ANTHROPIC chargeback per-day series over the SAME window (bill lane, scope-clamped)
    // — the chargeback-mode spend-trend series, alongside the §A `series` (never summed).
    const chargeSeries = await fetchRegionalChargebackTrend(tx, scope, win)
    return {
      month,
      region: scope.region,
      windowDays,
      series,
      chargeSeries,
      ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
    }
  })
})
