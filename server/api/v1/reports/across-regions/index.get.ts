/*
 * GET /api/v1/reports/across-regions?month — the Across-Regions reporting scope,
 * the WHOLE-OF-COMPANY enterprise rollup (docs/design/reporting-consolidation/
 * 00-build-design.md §2/§3).
 *
 * READS (build-design §4 lane matrix):
 *   - whole-company KPIs (genuine, MoM, active users, tokens, avg/user) + per-region
 *     comparison cards + active users → `v_complete_usage` (the §A completeness lane),
 *     `region_id` grain, `date_trunc('month')`, `COUNT(DISTINCT teammate_id)`.
 *   - the monetised chargeable-vs-genuine gap PER REGION → `v_finance_chargeback_month`
 *     (the §B bill lane). Copilot chargeable is gated on `copilot.mode`: held back
 *     with a "pending" marker until Wave 0 validates (build-design §6).
 *
 * RBAC (build-design §2): `requireRole('global-finops','platform-admin')`. This scope
 * is whole-company ONLY — no region/ou params are honoured for anyone (there is nothing
 * to clamp; every other role is a hard 403).
 *
 * No `attribution_record` / raw `actual_spend` (the lane firewall, §7(7)).
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import {
  fetchAcrossKpis,
  fetchAcrossRegionCards,
  fetchAcrossChargebackByRegion,
  fetchProviderSplit,
  fetchAcrossDailyMetrics,
  fetchAcrossChargebackTrend,
} from '../../../../reporting/across-regions'
import { forecastForMonth } from '../../../../reports/forecast'
import { providerStatesForWindow } from '../../../../reports/settling'
import { copilotChargebackEnabled, copilotFinanceMode } from '../../../../reports/copilot-mode'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'
import type { ReportMeta } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'global-finops', 'platform-admin')
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const now = new Date()
  const win = resolveReportWindow(query, { now })
  const copilotChargeback = copilotChargebackEnabled()

  // MoM + forecast are MONTH-anchored (build-design §5). Only the calendar-month
  // window carries them; a custom from/to range computes the SAME usage aggregates
  // over its bounds but returns momDeltaPct:null + forecast:null (an MTD/month
  // delta is meaningless for an arbitrary span). `metaMonth` is the window's
  // start-month representative used for the (month-grained) settling states + meta.
  //
  // MoM is LIKE-FOR-LIKE: the previous-month operand is clipped to the SAME
  // day-of-month PACE as the viewed month (fetchAcrossKpis derives the pace window
  // from the DATA's as-of day, not `now` — so settling lag can't reintroduce the
  // spurious early-month drop). Month path only; a custom range passes null.
  const momMonthRange = win.isMonth ? win.monthRange : null
  const metaMonth = win.monthStr ?? monthKeyUtc(new Date(win.startIso))

  return await withRequestRls(event, async (tx) => {
    const kpis = await fetchAcrossKpis(tx, win, { copilotChargeback, momMonthRange, now })
    const regionCards = await fetchAcrossRegionCards(tx, win, { copilotChargeback })
    // §B chargeback-by-region ranking — the chargeback-lane swap for the usage region
    // cards. Sourced off the bill lane so a region with charge but no in-window usage is
    // not dropped, and it sums back to kpis.chargeableUsd. Gated on copilotChargeback.
    const chargebackByRegion = await fetchAcrossChargebackByRegion(tx, win, { copilotChargeback })
    const providerSplit = await fetchProviderSplit(tx, win)
    // §A per-day sparkline series (attributed usage / tokens / active users / avg).
    const dailyMetrics = await fetchAcrossDailyMetrics(tx, win)
    // §B ANTHROPIC chargeback per-day series over the SAME window — the Chargeable
    // KPI-tile sparkline (bill lane). Separate from the trend endpoint's rolling window.
    const chargeDaily = await fetchAcrossChargebackTrend(tx, win)

    // Forecast is ALWAYS anchored on the in-progress month (closed months → null);
    // range mode has no month anchor, so it is null there too.
    const asOf = kpis.asOfDate ? new Date(`${kpis.asOfDate}T00:00:00.000Z`) : null
    const forecast =
      win.isMonth && win.monthStr
        ? forecastForMonth({ requestedMonth: win.monthStr, now, asOf, meteredMtdUsd: kpis.genuineUsd })
        : null

    const meta: ReportMeta = {
      month: metaMonth,
      monthFloor: kpis.monthFloor ?? metaMonth,
      asOfDate: kpis.asOfDate,
      providerStates: providerStatesForWindow(win, now),
      scope: 'across',
      // Usage dims are point-in-time "as at emit" (§A completeness lane).
      pointInTimeDims: true,
      ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
    }

    return {
      meta,
      kpis: {
        genuineUsd: kpis.genuineUsd,
        chargeableUsd: kpis.chargeableUsd,
        anthropicChargeableUsd: kpis.anthropicChargeableUsd,
        tokens: kpis.tokens,
        activeUsers: kpis.activeUsers,
        momDeltaPct: kpis.momDeltaPct,
        chargeMomDeltaPct: kpis.chargeMomDeltaPct,
        avgPerUserUsd: kpis.avgPerUserUsd,
        // §B chargeback-mode tile figures (Anthropic bill lane, per-teammate).
        billedTeammates: kpis.billedTeammates,
        billedTokens: kpis.billedTokens,
        avgChargePerBilledUser: kpis.avgChargePerBilledUser,
      },
      copilot: {
        mode: copilotFinanceMode(),
        // The chip shows "pending correct writer" until Wave 0 validates on Dev.
        pending: !copilotChargeback,
        // Copilot chargeback ON but a partial-month range → the pooled (monthly) net is
        // withheld (never a partial slice, never a silent $0 under "+ Copilot pooled net").
        partialMonthUnavailable: kpis.copilotPartialMonthUnavailable,
        chargeableUsd:
          copilotChargeback && !kpis.copilotPartialMonthUnavailable
            ? kpis.copilotChargeableUsd
            : null,
      },
      // §B provider split (bill lane) — Anthropic per-teammate chargeback vs Copilot
      // per-org pooled net (null while pending OR withheld for a partial-month range). The
      // two SUM BACK to kpis.chargeableUsd (same operands the KPI composes); NEVER summed
      // with the §A providerSplit.
      chargebackProviderSplit: {
        anthropicUsd: kpis.anthropicChargeableUsd,
        copilotUsd:
          copilotChargeback && !kpis.copilotPartialMonthUnavailable
            ? kpis.copilotChargeableUsd
            : null,
        partialMonthUnavailable: kpis.copilotPartialMonthUnavailable,
      },
      providerSplit,
      dailyMetrics,
      chargeDaily,
      forecast,
      actualUsd: kpis.genuineUsd,
      regionCards,
      chargebackByRegion,
    }
  })
})
