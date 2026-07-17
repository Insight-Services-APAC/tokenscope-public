/*
 * GET /api/v1/reports/across-regions/drivers?month&axis — the axis-switchable
 * whole-company ranked drivers + spend concentration behind the Across-Regions
 * DriversTable + ConcentrationCard (build-design §2/§3/§5).
 *
 * `axis=region|practice|teammate|model`; whole-company denominators; grouped over
 * `v_complete_usage` (the usage lane). The rows SUM BACK to the headline in the
 * same lane (build-design §7(4)) — the NULL bucket (unassigned region / no-practice /
 * unattributed model) is always present so the sum-back holds.
 *
 * `concentration` is the top-1/5/10% cohort shares + power/heavy/typical/light
 * segments (avg + median per segment), computed once per call from the same lane
 * (build-design §5). Same RBAC as `/reports/across-regions`. Lane firewall: §7(7).
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireReportScope } from '../../../../auth/report-scope'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import {
  fetchAcrossDrivers,
  fetchConcentration,
  ACROSS_DRIVER_AXES,
} from '../../../../reporting/across-regions'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  axis: z.enum(ACROSS_DRIVER_AXES).default('region'),
})

export default defineEventHandler(async (event) => {
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  // Month OR custom from/to window (drivers + concentration are usage-lane, so a
  // custom range windows cleanly). Month mode is byte-identical to the old path.
  const win = resolveReportWindow(query)
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))

  return await withRequestRls(event, async (tx) => {
    await requireReportScope(event, tx, 'across')
    const { rows, headlineUsd } = await fetchAcrossDrivers(tx, win, query.axis)
    const concentration = await fetchConcentration(tx, win)
    return {
      month,
      axis: query.axis,
      headlineUsd,
      rows,
      concentration,
      ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
    }
  })
})
