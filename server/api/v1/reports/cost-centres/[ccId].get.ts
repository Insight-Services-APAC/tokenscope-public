/*
 * GET /api/v1/reports/cost-centres/[ccId]?month&axis — the Cost-Centre BURN drill
 * (docs/design/reporting-consolidation/00-build-design.md §2/§3/§4, Wave 3).
 *
 * READS (§A completeness lane, the SAME axis as the tracker card burn):
 *   - burn total + vendor split → `v_complete_usage WHERE cost_owning_unit_id`
 *     (Copilot pooled NULL-CoU rows excluded by construction — the labelled §A gap).
 *   - axis drivers (teammate|model): who/what is burning the budget, summing back
 *     to the burn — including a spender whose CURRENT placement has moved (§A homes
 *     by emit-time cost_owning_unit_id, so they never vanish from the burn).
 *   - the CC's current-effective allocation (burn-vs-budget context).
 * The §B chargeback/billing for this CC lives in the Finance scope's CoU drill —
 * NOT duplicated here (a budget-BURN tracker's drill shows consumption, not invoices).
 *
 * RBAC (build-design §2 — resource-anchored, anti-IDOR): resolve the CC's region,
 * then grant iff the caller OWNS it OR holds region scope (requireRegionScope).
 * A foreign/unowned CC → 403; a non-existent CC → 404 (resolveCostCentreDrill).
 *
 * No `attribution_record` / raw `actual_spend` / `v_finance_*` (the lane firewall, §7(7)).
 */
import { defineEventHandler, getValidatedQuery, getRouterParam, createError } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import {
  resolveCostCentreDrill,
  fetchCostCentreBurnDrill,
  fetchCostCentreBurnDrivers,
  fetchCostCentreAllocation,
  COST_CENTRE_DRILL_AXES,
} from '../../../../reporting/cost-centres'
import { providerStatesForWindow } from '../../../../reports/settling'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'
import type { ReportMeta } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  axis: z.enum(COST_CENTRE_DRILL_AXES).default('teammate'),
})

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const ccId = getRouterParam(event, 'ccId')
  if (!ccId || !/^[0-9a-f-]{36}$/i.test(ccId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid cost centre id' })
  }
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const now = new Date()
  // Month OR custom from/to window — the SAME window resolveReportWindow gives the
  // tracker index/card. In range mode (This quarter / Custom) the drill burn windows
  // the WHOLE range, so the §A drill headline reconciles to the range-windowed
  // tracker card burn in EVERY mode. Month mode is byte-identical to the old path.
  const win = resolveReportWindow(query, { now })
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))

  return await withRequestRls(event, async (tx) => {
    const cc = await resolveCostCentreDrill(tx, event, session, ccId)

    const burn = await fetchCostCentreBurnDrill(tx, cc.id, win)
    const drivers = await fetchCostCentreBurnDrivers(tx, cc.id, win, query.axis, burn.burnUsd)
    const allocationUsd = await fetchCostCentreAllocation(tx, cc.id)

    const meta: ReportMeta = {
      month,
      monthFloor: month,
      asOfDate: burn.asOf,
      providerStates: providerStatesForWindow(win, now),
      scope: 'cost-centre',
      // §A usage burn homed by emit-time cost_owning_unit_id (point-in-time "as at emit").
      pointInTimeDims: true,
      // Present only in custom-range mode so the drill discloses the active window.
      ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
    }

    return {
      meta,
      cc: { id: cc.id, code: cc.code, displayName: cc.displayName, regionCode: cc.regionCode },
      burnUsd: burn.burnUsd,
      vendor: burn.vendor,
      allocationUsd,
      axis: query.axis,
      headlineUsd: drivers.headlineUsd,
      denominatorLabel: drivers.denominatorLabel,
      rows: drivers.rows,
    }
  })
})
