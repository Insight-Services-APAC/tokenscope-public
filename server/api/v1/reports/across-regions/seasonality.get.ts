/*
 * GET /api/v1/reports/across-regions/seasonality?month | ?from&to — the real
 * day-of-week × ISO-week seasonality heatmap for the WHOLE-OF-COMPANY Across-Regions
 * scope (the AEUF-exceed "cyclical" visual — actual usage, not a synthesized curve).
 *
 * Same lane (`v_complete_usage`) + RBAC (`global-finops` / `platform-admin` only) as
 * `/reports/across-regions`. Grouped by ISO week × ISO dow over the active window — a
 * calendar month by default (`?month`), or a custom `[from, to]` range (both
 * `YYYY-MM-DD`, inclusive `to`).
 *
 * Lane firewall (build-design §7(7)): no `attribution_record` / raw `actual_spend`.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireReportScope } from '../../../../auth/report-scope'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import { fetchAcrossSeasonality, fetchAcrossChargebackDow } from '../../../../reporting/across-regions'
import { MONTH_REGEX } from '../../../../utils/period'
import type { Seasonality } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
})

export default defineEventHandler(async (event): Promise<Seasonality> => {
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const win = resolveReportWindow(query)

  return await withRequestRls(event, async (tx) => {
    await requireReportScope(event, tx, 'across')
    const { weeks, cells } = await fetchAcrossSeasonality(tx, win)
    // §B ANTHROPIC chargeback by day-of-week over the SAME window (bill lane) — the
    // chargeback-mode "when spend happens", carried alongside the §A cells (never summed).
    const chargeDow = await fetchAcrossChargebackDow(tx, win)
    return { window: { from: win.from, to: win.to }, weeks, cells, chargeDow }
  })
})
