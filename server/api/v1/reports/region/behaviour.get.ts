/*
 * GET /api/v1/reports/region/behaviour?month|from&to&region&ou? — the two
 * BEHAVIOUR cards for the Region scope, at either width (§6 merge).
 *
 * `?region=all` → whole-company; otherwise one region's, scope-clamped. Both
 * widths answer the same two questions, and one handler is the point: these cards
 * arrived as a pair of near-identical endpoints from two parallel tracks, which is
 * exactly the duplication `engine/scope.ts` exists to end.
 *
 * READS, one lane each and NEVER summed (contract C2):
 *   - Behavioural exposure → `provider_usage_fact` ⋈ `model_catalog` (the §B
 *     billed lane), banded in TypeScript through `resolveTier` so this card and
 *     the frontier-share detector cannot publish two different frontier shares,
 *     and so no join can fan out on the catalog's SUBSTRING patterns.
 *   - Spend per active developer → `v_complete_usage` (the §A usage lane) via
 *     `fetchDailyMetrics`, the SAME primitive the KPI sparklines ride. No new
 *     query: the card divides two figures that already exist.
 *
 * THE WINDOW IS THE CALLER'S, and the client sends the ROLLING one. Both cards
 * draw in the "Last 60 days" band, decoupled from the month picker above them.
 * Nothing here defaults to 60 days — an endpoint that silently overrode the window
 * it was handed would make the header lie about the figures beneath it.
 *
 * Authorization rides `resolveRegionRequest`, the same total function that decides
 * the tab and the selector (`regionScopeGrant`), so the control a caller sees and
 * the width the server serves cannot drift apart.
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
  fetchAcrossTierExposure,
  fetchAcrossDailyMetrics,
} from '../../../../reporting/across-regions'
import {
  fetchRegionalTierExposure,
  fetchRegionalDailyMetrics,
} from '../../../../reporting/regional'
import { buildPerDeveloperSeries } from '../../../../../shared/reports/per-developer'
import { MONTH_REGEX } from '../../../../utils/period'
import { requestClock } from '../../../../utils/request-clock'
import type { BehaviourReport } from '../../../../../shared/reports/behaviour'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  region: z.string().refine(isValidRegionParam, 'region must be a uuid or "all"').optional(),
  ou: z.string().uuid().optional(),
})

export default defineEventHandler(async (event): Promise<BehaviourReport> => {
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  // ONE clock for this request (F1/D1) — the window resolver and the series
  // frontier read the same instant, so the axis cannot straddle UTC midnight.
  const clock = requestClock(event)
  const win = resolveReportWindow(query, { now: new Date(clock.now) })
  const window = { from: win.from, to: win.to }

  // Authz tx first, compute tx only for a cache-miss leader (plan D5/r1-M2).
  const req = await withRequestRls(event, (tx) =>
    resolveRegionRequest(event, tx, { region: query.region, ou: query.ou }),
  )
  const session = await requireAuth(event)
  const idKey = identityKey(session)

  return await withReportCache(
    event,
    ['region/behaviour', normalizedQuery(query), idKey, regionRequestKey(req)],
    () =>
      withRequestRls(event, async (tx): Promise<BehaviourReport> => {
        if (req.width === 'all-regions') {
          // Concurrent issuance on ONE tx connection: postgres-js pipelines and
          // answers in order — no per-query await gaps (fully one wave on
          // prepared statements), no cross-dependencies
          // (docs/design/request-floor-performance.md F5).
          //
          // `daily` is the composite's dailyMetrics — memoized (D8). NOTE the
          // sharing is per-WINDOW: this card usually arrives with the rolling
          // 60-day band, which shares only with callers on the same band.
          const [exposure, daily] = await Promise.all([
            fetchAcrossTierExposure(tx, win),
            memoizedScan(
              ['across-daily-metrics', idKey, win.startIso, win.endIso, clock.settledThrough],
              () => fetchAcrossDailyMetrics(tx, win, clock),
            ),
          ])
          return {
            window,
            width: 'all-regions' as const,
            region: null,
            exposure,
            perDeveloper: buildPerDeveloperSeries(daily, window),
          }
        }

        const { scope } = req
        // One round-trip wave, no cross-dependencies (request-floor-performance.md F5).
        const [exposure, daily] = await Promise.all([
          fetchRegionalTierExposure(tx, scope, win),
          memoizedScan(
            ['regional-daily-metrics', idKey, scope.scopeKey, win.startIso, win.endIso, clock.settledThrough],
            () => fetchRegionalDailyMetrics(tx, scope, win, clock),
          ),
        ])
        return {
          window,
          width: 'region' as const,
          region: scope.region,
          exposure,
          perDeveloper: buildPerDeveloperSeries(daily, window),
        }
      }),
  )
})
