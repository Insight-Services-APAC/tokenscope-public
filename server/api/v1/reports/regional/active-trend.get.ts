/*
 * GET /api/v1/reports/regional/active-trend?month|from&to&region&ou? — the
 * active-users-over-time series (distinct active teammates per tool, per day) for the
 * Regional scope (the AEUF-exceed "how many devs on each tool" as a trend, region-scoped).
 *
 * Same lane (`v_complete_usage`) + scope (resolveRegionalScope) as `/reports/regional`.
 * One point per UTC day with any in-scope usage over the active window — a calendar
 * month by default (`?month`) or a custom `[from, to]` range.
 *
 * Lane firewall (build-design §7(7)): no `attribution_record` / raw `actual_spend`.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { resolveReportGrants } from '../../../../auth/report-scope'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import { resolveRegionalScope, fetchRegionalActiveTrend } from '../../../../reporting/regional'
import { MONTH_REGEX } from '../../../../utils/period'
import type { ActiveTrend } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  region: z.string().uuid().optional(),
  ou: z.string().uuid().optional(),
})

export default defineEventHandler(async (event): Promise<ActiveTrend> => {
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
    const series = await fetchRegionalActiveTrend(tx, scope, win)
    return { window: { from: win.from, to: win.to }, series }
  })
})
