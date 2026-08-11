/*
 * GET /api/v1/reports/region/trend?month|from&to&region&ou? — the day-grain,
 * vendor-stacked usage trend for the Region scope, at either width (§6 merge).
 *
 * `?region=all` → the whole-company series (the retired
 * `/reports/across-regions/trend`); otherwise one region's, scope-clamped (the
 * retired `/reports/regional/trend`). Same lane (`v_complete_usage`) and the same
 * four series at both widths — §A `series`, the §B `chargeSeries` and its per-lane
 * widening `chargeLanes`, and the §A `usageWeeklyLanes` cells. The §A and §B series
 * ride alongside each other and are NEVER summed.
 *
 * Lane firewall (build-design §7(7)): no `attribution_record` / raw `actual_spend`.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../utils/auth'
import { withRequestRls } from '../../../../db/request-rls'
import {
  withReportCache,
  memoizedScan,
  identityKey,
  normalizedQuery,
  regionRequestKey,
} from '../../../../reporting/report-cache'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import { resolveRegionRequest, isValidRegionParam } from '../../../../reporting/region-scope'
import {
  fetchAcrossTrend,
  fetchAcrossChargebackTrend,
  fetchAcrossChargebackLaneTrend,
  fetchAcrossUsageWeeklyLanes,
} from '../../../../reporting/across-regions'
import {
  fetchRegionalTrend,
  fetchRegionalChargebackTrend,
  fetchRegionalChargebackLaneTrend,
  fetchRegionalUsageWeeklyLanes,
} from '../../../../reporting/regional'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'
import { requestClock } from '../../../../utils/request-clock'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  region: z.string().refine(isValidRegionParam, 'region must be a uuid or "all"').optional(),
  ou: z.string().uuid().optional(),
})

export default defineEventHandler(async (event) => {
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  // ONE clock for this request (F1/D1).
  const clock = requestClock(event)
  const win = resolveReportWindow(query, { now: new Date(clock.now) })
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))

  // Authz tx first, compute tx only for a cache-miss leader (plan D5/r1-M2).
  const req = await withRequestRls(event, (tx) =>
    resolveRegionRequest(event, tx, { region: query.region, ou: query.ou }),
  )
  const session = await requireAuth(event)
  const idKey = identityKey(session)

  return await withReportCache(
    event,
    ['region/trend', normalizedQuery(query), idKey, regionRequestKey(req)],
    () => withRequestRls(event, async (tx) => {
    if (req.width === 'all-regions') {
      const series = await fetchAcrossTrend(tx, win)
      // The same series the composite's chargeDaily carries — memoized (D8) so
      // the page's concurrent XHRs compute it once.
      const chargeSeries = await memoizedScan(
        ['across-charge-trend', idKey, win.startIso, win.endIso, clock.settledThrough],
        () => fetchAcrossChargebackTrend(tx, win, clock),
      )
      // Σ lanes per day == chargeSeries[day], cent-exact (test-pinned).
      const chargeLanes = await fetchAcrossChargebackLaneTrend(tx, win)
      // Σ cells == this window's genuine usage total (test-pinned); `window` below is
      // the ONE shared window object the hero + its pinned donut both bind on.
      const usageWeeklyLanes = await fetchAcrossUsageWeeklyLanes(tx, win)
      return {
        month,
        width: 'all-regions' as const,
        region: null,
        window: { from: win.from, to: win.to },
        series,
        chargeSeries,
        chargeLanes,
        usageWeeklyLanes,
        ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
      }
    }

    const { scope } = req
    const { series, windowDays } = await fetchRegionalTrend(tx, scope, win)
    const chargeSeries = await memoizedScan(
      ['regional-charge-trend', idKey, scope.scopeKey, win.startIso, win.endIso, clock.settledThrough],
      () => fetchRegionalChargebackTrend(tx, scope, win, clock),
    )
    const chargeLanes = await fetchRegionalChargebackLaneTrend(tx, scope, win)
    const usageWeeklyLanes = await fetchRegionalUsageWeeklyLanes(tx, scope, win)
    return {
      month,
      width: 'region' as const,
      region: scope.region,
      window: { from: win.from, to: win.to },
      windowDays,
      series,
      chargeSeries,
      chargeLanes,
      usageWeeklyLanes,
      ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
    }
    }),
  )
})
