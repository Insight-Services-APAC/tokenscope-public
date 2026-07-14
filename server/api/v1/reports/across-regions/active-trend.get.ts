/*
 * GET /api/v1/reports/across-regions/active-trend?month | ?from&to — the
 * active-users-over-time series (distinct active teammates per tool, per day) for the
 * WHOLE-OF-COMPANY Across-Regions scope (the AEUF-exceed "how many devs on each tool"
 * as a trend, not a point KPI).
 *
 * Same lane (`v_complete_usage`) + RBAC (`global-finops` / `platform-admin` only) as
 * `/reports/across-regions`. One point per UTC day with any usage over the active
 * window — a calendar month by default (`?month`), or a custom `[from, to]` range.
 *
 * Lane firewall (build-design §7(7)): no `attribution_record` / raw `actual_spend`.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import { fetchAcrossActiveTrend } from '../../../../reporting/across-regions'
import { MONTH_REGEX } from '../../../../utils/period'
import type { ActiveTrend } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
})

export default defineEventHandler(async (event): Promise<ActiveTrend> => {
  await requireRole(event, 'global-finops', 'platform-admin')
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const win = resolveReportWindow(query)

  return await withRequestRls(event, async (tx) => {
    const series = await fetchAcrossActiveTrend(tx, win)
    return { window: { from: win.from, to: win.to }, series }
  })
})
