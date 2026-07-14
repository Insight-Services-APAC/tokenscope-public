/*
 * GET /api/v1/reports/regional?month&region&ou? — the Regional reporting scope
 * (docs/design/reporting-consolidation/00-build-design.md §2/§3).
 *
 * READS (build-design §4 lane matrix):
 *   - usage KPIs / practice ranking / exceptions / forecast → `v_complete_usage`
 *     (the §A completeness lane), region/subtree/`ou`-subtree scoped.
 *   - the monetised genuine-vs-chargeable pair → `v_finance_chargeback_month`
 *     (the §B bill lane). Copilot chargeable is gated on `copilot.mode`: held back
 *     with a "pending" marker until Wave 0 validates (build-design §6).
 *
 * RBAC (build-design §2 branch) is enforced inside resolveRegionalScope:
 *   admin own-region force · global-finops/platform-admin any region · manager/
 *   developer subtree (region-clamped) · `ou` drill = subtree OR ownership
 *   (foreign-region resource → 403 anti-IDOR).
 *
 * No `attribution_record` / raw `actual_spend` (the lane firewall, §7(7)).
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import {
  resolveRegionalScope,
  fetchRegionalKpis,
  fetchRegionalPractices,
  fetchRegionalChargebackByCostCentre,
  fetchRegionalDailyMetrics,
  fetchRegionalChargebackTrend,
  fetchRegionalVendorSplit,
  fetchRegionalProviderSplit,
  fetchRegionalExceptions,
} from '../../../../reporting/regional'
import { forecastForMonth } from '../../../../reports/forecast'
import { providerStatesForWindow } from '../../../../reports/settling'
import { copilotChargebackEnabled, copilotFinanceMode } from '../../../../reports/copilot-mode'
import { resolveVelocitySpikeThreshold } from '../../../../reports/velocity'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'
import type { ReportMeta } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  region: z.string().uuid().optional(),
  ou: z.string().uuid().optional(),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(
    event,
    'developer',
    'manager',
    'admin',
    'global-finops',
    'platform-admin',
  )
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const now = new Date()
  // Month OR custom from/to window. `metaMonth` is the window's start-month
  // representative used for the month-grained settling states + meta. Month mode is
  // byte-identical to the old path.
  const win = resolveReportWindow(query, { now })
  const metaMonth = win.monthStr ?? monthKeyUtc(new Date(win.startIso))
  const copilotChargeback = copilotChargebackEnabled()
  // MoM (both lanes) is MONTH-anchored: the month path passes the viewed month's range
  // so fetchRegionalKpis can derive the previous-month chargeback operand; a custom
  // range passes null (an MTD/month delta is meaningless over an arbitrary span).
  const momMonthRange = win.isMonth ? win.monthRange : null

  return await withRequestRls(event, async (tx) => {
    const scope = await resolveRegionalScope(tx, caller, { region: query.region, ou: query.ou })

    const kpis = await fetchRegionalKpis(tx, scope, win, { copilotChargeback, momMonthRange, now })

    // Forecast is ALWAYS anchored on the in-progress month (closed months → null);
    // a custom range has no month anchor, so it is null there too.
    const asOf = kpis.asOfDate ? new Date(`${kpis.asOfDate}T00:00:00.000Z`) : null
    const forecast =
      win.isMonth && win.monthStr
        ? forecastForMonth({ requestedMonth: win.monthStr, now, asOf, meteredMtdUsd: kpis.genuineUsd })
        : null

    // Top-level shows the practice ranking; the `ou` drill shows the vendor donut.
    const practices = scope.ou ? [] : await fetchRegionalPractices(tx, scope, win)
    // §B chargeback-by-cost-centre ranking — the chargeback-lane swap for the practice
    // rank (top-level only, mirroring practices). Gated on copilotChargeback like the KPI.
    const chargebackByCostCentre = scope.ou
      ? []
      : await fetchRegionalChargebackByCostCentre(tx, scope, win, { copilotChargeback })
    const vendorSplit = scope.ou ? await fetchRegionalVendorSplit(tx, scope, win) : null
    const providerSplit = await fetchRegionalProviderSplit(tx, scope, win)
    // §A per-day sparkline series for the KPI tiles (attributed usage / tokens / users).
    const dailyMetrics = await fetchRegionalDailyMetrics(tx, scope, win)
    // §B ANTHROPIC chargeback per-day series over the SAME window — the Chargeable
    // KPI-tile sparkline (bill lane, scope-clamped). Separate from the rolling trend endpoint.
    const chargeDaily = await fetchRegionalChargebackTrend(tx, scope, win)

    const threshold = await resolveVelocitySpikeThreshold(tx, scope.effectiveRegionId)
    const exceptions = await fetchRegionalExceptions(tx, scope, threshold)

    const meta: ReportMeta = {
      month: metaMonth,
      monthFloor: kpis.monthFloor ?? metaMonth,
      asOfDate: kpis.asOfDate,
      providerStates: providerStatesForWindow(win, now),
      scope: 'regional',
      pointInTimeDims: scope.pointInTimeDims,
      ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
    }

    return {
      meta,
      region: scope.region,
      regionOptions: scope.regionOptions,
      drill: scope.ou
        ? { ouId: scope.ou.id, code: scope.ou.code, displayName: scope.ou.displayName }
        : null,
      kpis: {
        genuineUsd: kpis.genuineUsd,
        chargeableUsd: kpis.chargeableUsd,
        anthropicChargeableUsd: kpis.anthropicChargeableUsd,
        tokens: kpis.tokens,
        activeUsers: kpis.activeUsers,
        chargeMomDeltaPct: kpis.chargeMomDeltaPct,
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
      // per-org pooled net (null while pending OR withheld for a partial-month range). SUMS
      // BACK to kpis.chargeableUsd; NEVER summed with the §A providerSplit.
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
      practices,
      chargebackByCostCentre,
      vendorSplit,
      exceptions,
      velocityThreshold: threshold,
    }
  })
})
