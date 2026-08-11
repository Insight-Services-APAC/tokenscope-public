/*
 * GET /api/v1/reports/region/seasonality?month|from&to&region&ou? — the real
 * day-of-week × ISO-week seasonality heatmap for the Region scope at either width
 * (§6 merge; the retired `/reports/{across-regions,regional}/seasonality`).
 *
 * Same lane (`v_complete_usage`) at both widths, grouped by ISO week × ISO dow over
 * the active window — a calendar month by default (`?month`) or a custom
 * `[from, to]` range. Actual usage, never a synthesized curve.
 *
 * The §B `chargeDow` (Anthropic chargeback by day-of-week, bill lane) rides
 * alongside the §A cells and is NEVER summed with them.
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
import {
  fetchAcrossSeasonality,
  fetchAcrossChargebackDow,
} from '../../../../reporting/across-regions'
import {
  fetchRegionalSeasonality,
  fetchRegionalChargebackDow,
} from '../../../../reporting/regional'
import { MONTH_REGEX } from '../../../../utils/period'
import type { Seasonality } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  region: z.string().refine(isValidRegionParam, 'region must be a uuid or "all"').optional(),
  ou: z.string().uuid().optional(),
})

export default defineEventHandler(async (event): Promise<Seasonality> => {
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const win = resolveReportWindow(query)

  // Authz tx first, compute tx only for a cache-miss leader (plan D5/r1-M2).
  const req = await withRequestRls(event, (tx) =>
    resolveRegionRequest(event, tx, { region: query.region, ou: query.ou }),
  )
  const session = await requireAuth(event)

  return await withReportCache(
    event,
    ['region/seasonality', normalizedQuery(query), identityKey(session), regionRequestKey(req)],
    () =>
      withRequestRls(event, async (tx) => {
        if (req.width === 'all-regions') {
          const { weeks, cells } = await fetchAcrossSeasonality(tx, win)
          const chargeDow = await fetchAcrossChargebackDow(tx, win)
          return { window: { from: win.from, to: win.to }, weeks, cells, chargeDow }
        }
        const { weeks, cells } = await fetchRegionalSeasonality(tx, req.scope, win)
        const chargeDow = await fetchRegionalChargebackDow(tx, req.scope, win)
        return { window: { from: win.from, to: win.to }, weeks, cells, chargeDow }
      }),
  )
})
