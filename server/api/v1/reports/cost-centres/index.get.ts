/*
 * GET /api/v1/reports/cost-centres?month — the Cost-Centre reporting scope card
 * grid (docs/design/reporting-consolidation/00-build-design.md §2/§3, Wave 3).
 *
 * READS (build-design §4 lane matrix): burn = `v_complete_usage WHERE
 * cost_owning_unit_id` (the PROJECT-CoU USAGE axis — Copilot NULL-CoU pooled rows
 * are excluded by construction and labelled). Allocation joins the CC's lead
 * projects. The card carries BOTH on-track mechanics, kept DISTINCT:
 *   - exhaustionDate — the BUDGET-exhaustion DATE (projections.ts), a date.
 *   - forecast       — the RUN-RATE dollar projection (forecast.ts), a $.
 * Both are computed only on the in-progress month (closed months → null/null).
 *
 * RBAC (build-design §2): `requireAuth` + in-query scope = `getOwnedCostCentreIds`
 * ∪ the caller's cost-owning subtree (fetchVisibleCostCentres). NO region
 * denominators for pure owners — the scope is the set of visible CCs, nothing
 * wider. Every figure re-enforces its own gate.
 *
 * No `attribution_record` / raw provider-bill table (the lane firewall, §7(7)).
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import {
  fetchVisibleCostCentres,
  fetchCostCentreCards,
  summariseCostCentres,
} from '../../../../reporting/cost-centres'
import { providerStatesForWindow } from '../../../../reports/settling'
import { copilotChargebackEnabled } from '../../../../reports/copilot-mode'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'
import type { ReportMeta } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
})

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const now = new Date()
  // Month OR custom from/to window. The window filters BURN; allocation is
  // current-effective (window-independent). The month-anchored mechanics (forecast
  // run-rate $ + exhaustion date) are computed only in month mode — a custom range
  // has no month anchor, so `monthCtx` is null and both are null (matching the other
  // scopes' forecast-null-in-range rule). Month mode is byte-identical to the old path.
  const win = resolveReportWindow(query, { now })
  const metaMonth = win.monthStr ?? monthKeyUtc(new Date(win.startIso))
  const monthCtx = win.isMonth && win.monthStr ? { month: win.monthStr, now } : null
  const copilotChargeback = copilotChargebackEnabled()

  return await withRequestRls(event, async (tx) => {
    const ccs = await fetchVisibleCostCentres(tx)
    const { cards, asOfDate, monthFloor, copilotChargebackPartialMonth } =
      await fetchCostCentreCards(tx, ccs, win, monthCtx, {
        copilotChargeback,
      })
    // A KPI strip + RAG rollup for the visible cards (burn/allocation totals + over/
    // near/on-track/no-allocation counts) — computed purely from the cards.
    const summary = summariseCostCentres(cards, asOfDate)

    const meta: ReportMeta = {
      month: metaMonth,
      monthFloor: monthFloor ?? metaMonth,
      asOfDate,
      providerStates: providerStatesForWindow(win, now),
      scope: 'cost-centre',
      // Burn is the point-in-time emit-home cost_owning_unit_id (usage lane).
      pointInTimeDims: true,
      ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
    }

    return {
      meta,
      summary,
      cards,
      // §B — copilot chargeback ON over a partial-month range → the pooled (monthly)
      // Copilot net is withheld from every card's chargeUsd (never a partial slice); the
      // chargeback-mode view caveats the omission rather than showing a silent $0.
      copilotChargebackPartialMonth,
      // The per-CC burn is the PROJECT-CoU usage axis; pooled Copilot usage with no
      // cost-owning unit is excluded from it (the labelled §A NULL-CoU gap). The
      // drill's showback/chargeable columns are the SEPARATE teammate-homed lane.
      laneNote:
        'Per-cost-centre burn is the project cost-owning-unit usage axis. Pooled Copilot usage with no cost-owning unit is excluded here and shown in the finance drill.',
    }
  })
})
