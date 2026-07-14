/*
 * GET /api/v1/reports/across-regions/trend?month | ?from&to — the day-grain,
 * vendor-stacked usage trend for the WHOLE-OF-COMPANY Across-Regions scope
 * (reporting-consolidation; mirrors `/reports/regional/trend` one tier up).
 *
 * Same lane (`v_complete_usage`) + RBAC (`global-finops` / `platform-admin` only)
 * as `/reports/across-regions`. Per-day split into claude-code / copilot-cli /
 * other over the active window — a calendar month by default (`?month`), or a
 * custom `[from, to]` range (both `YYYY-MM-DD`, inclusive `to`).
 *
 * Lane firewall (build-design §7(7)): no `attribution_record` / raw `actual_spend`.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import { fetchAcrossTrend, fetchAcrossChargebackTrend } from '../../../../reporting/across-regions'
import { MONTH_REGEX } from '../../../../utils/period'
import type { AcrossTrend } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
})

export default defineEventHandler(async (event): Promise<AcrossTrend> => {
  await requireRole(event, 'global-finops', 'platform-admin')
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const win = resolveReportWindow(query)

  return await withRequestRls(event, async (tx) => {
    const series = await fetchAcrossTrend(tx, win)
    // §B ANTHROPIC chargeback per-day series over the SAME window (bill lane) — the
    // chargeback-mode spend-trend series, carried alongside the §A `series` (never summed).
    const chargeSeries = await fetchAcrossChargebackTrend(tx, win)
    return { window: { from: win.from, to: win.to }, series, chargeSeries }
  })
})
