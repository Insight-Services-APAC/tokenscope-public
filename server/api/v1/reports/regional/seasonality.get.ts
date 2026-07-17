/*
 * GET /api/v1/reports/regional/seasonality?month|from&to&region&ou? — the real
 * day-of-week × ISO-week seasonality heatmap for the Regional scope (the AEUF-exceed
 * "cyclical" visual — actual usage, region-scoped).
 *
 * Same lane (`v_complete_usage`) + scope (resolveRegionalScope: admin own-region ·
 * global/platform any · manager/developer subtree · `ou` drill anti-IDOR) as
 * `/reports/regional`. Grouped by ISO week × ISO dow over the active window — a
 * calendar month by default (`?month`) or a custom `[from, to]` range.
 *
 * Lane firewall (build-design §7(7)): no `attribution_record` / raw `actual_spend`.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { resolveReportGrants } from '../../../../auth/report-scope'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import {
  resolveRegionalScope,
  fetchRegionalSeasonality,
  fetchRegionalChargebackDow,
} from '../../../../reporting/regional'
import { MONTH_REGEX } from '../../../../utils/period'
import type { Seasonality } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  region: z.string().uuid().optional(),
  ou: z.string().uuid().optional(),
})

export default defineEventHandler(async (event): Promise<Seasonality> => {
  const caller = await requireRole(
    event,
    'developer',
    'manager',
    'admin',
    'global-finops',
    'platform-admin',
  )
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const win = resolveReportWindow(query)

  return await withRequestRls(event, async (tx) => {
    const grants = await resolveReportGrants(event, tx, caller)
    const scope = await resolveRegionalScope(
      tx,
      caller,
      { region: query.region, ou: query.ou },
      { crossRegion: grants.regional === 'all-regions' },
    )
    const { weeks, cells } = await fetchRegionalSeasonality(tx, scope, win)
    // §B ANTHROPIC chargeback by day-of-week over the SAME window (bill lane, scope-clamped)
    // — the chargeback-mode "when spend happens", alongside the §A cells (never summed).
    const chargeDow = await fetchRegionalChargebackDow(tx, scope, win)
    return { window: { from: win.from, to: win.to }, weeks, cells, chargeDow }
  })
})
