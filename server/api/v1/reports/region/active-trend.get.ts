/*
 * GET /api/v1/reports/region/active-trend?month|from&to&region&ou? — distinct
 * active teammates per tool, per UTC day, for the Region scope at either width
 * (§6 merge; the retired `/reports/{across-regions,regional}/active-trend`).
 *
 * Same lane (`v_complete_usage`) at both widths: one point per day with any
 * in-scope usage over the active window — a calendar month by default (`?month`)
 * or a custom `[from, to]` range.
 *
 * Lane firewall (build-design §7(7)): no `attribution_record` / raw `actual_spend`.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../utils/auth'
import { withRequestRls } from '../../../../db/request-rls'
import {
  withReportCache,
  identityKey,
  normalizedQuery,
  regionRequestKey,
} from '../../../../reporting/report-cache'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import { resolveRegionRequest, isValidRegionParam } from '../../../../reporting/region-scope'
import { fetchAcrossActiveTrend } from '../../../../reporting/across-regions'
import { fetchRegionalActiveTrend } from '../../../../reporting/regional'
import { MONTH_REGEX } from '../../../../utils/period'
import type { ActiveTrend } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  region: z.string().refine(isValidRegionParam, 'region must be a uuid or "all"').optional(),
  ou: z.string().uuid().optional(),
})

export default defineEventHandler(async (event): Promise<ActiveTrend> => {
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const win = resolveReportWindow(query)

  // Authz tx first, compute tx only for a cache-miss leader (plan D5/r1-M2).
  const req = await withRequestRls(event, (tx) =>
    resolveRegionRequest(event, tx, { region: query.region, ou: query.ou }),
  )
  const session = await requireAuth(event)

  return await withReportCache(
    event,
    ['region/active-trend', normalizedQuery(query), identityKey(session), regionRequestKey(req)],
    () =>
      withRequestRls(event, async (tx) => {
        const series =
          req.width === 'all-regions'
            ? await fetchAcrossActiveTrend(tx, win)
            : await fetchRegionalActiveTrend(tx, req.scope, win)
        return { window: { from: win.from, to: win.to }, series }
      }),
  )
})
