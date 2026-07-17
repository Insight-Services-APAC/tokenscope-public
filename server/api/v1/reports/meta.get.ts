/*
 * GET /api/v1/reports/meta — the ONE bootstrap fetch for the reporting shell
 * (docs/design/reporting-consolidation/00-build-design.md §2).
 *
 * Returns:
 *   - scopes            → the GRANTED scopes only (role + CC-ownership derived).
 *   - defaultScope      → best-granted (across → regional → cost-centre → finance).
 *   - defaultRegionId   → the caller's home region (or first real region for a
 *                         cross-region role whose home is unset).
 *   - monthFloors       → MIN over the lanes (usage / bill / reconciliation),
 *                         daily-cacheable; `overall` = the picker floor.
 *   - providerStates    → settling states for the current month (settling.ts).
 *   - copilotMode       → 'pool-utilisation' | 'chargeback' (copilot-mode.ts).
 *
 * `requireAuth` — every scope re-enforces its own gate; this is the UX bootstrap.
 * Reads views/aggregate tables only — no `attribution_record` / raw `actual_spend`
 * (the lane firewall, build-design §7(7)).
 */
import { defineEventHandler, setHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { computeOwnsCostCentre, getReportVisibilityMode } from '../../../auth/report-scope'
import { reportGrants } from '../../../../shared/auth/report-visibility'
import { providerStatesForMonth } from '../../../reports/settling'
import { copilotFinanceMode } from '../../../reports/copilot-mode'
import { monthKeyUtc } from '../../../utils/period'
import { REPORT_SCOPES, type ReportScope } from '../../../../shared/reports/types'

interface FloorRow extends Record<string, unknown> {
  usage: string | null
  bill: string | null
  reconciliation: string | null
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const now = new Date()
  const currentMonth = monthKeyUtc(now)

  return await withRequestRls(event, async (tx) => {
    // The granted tabs now come from the ONE source of truth (reportGrants), so the
    // shell can never light up a tab the endpoint would 403. CC ownership (a
    // RELATIONSHIP, not a role) still feeds the cost-centre grant. Byte-identical to
    // the old inline map under the default 'standard' policy.
    const mode = await getReportVisibilityMode(event, tx)
    const ownsCostCentre = await computeOwnsCostCentre(tx, session.teammateId)
    const g = reportGrants(mode, { role: session.role, ownsCostCentre })

    // Map the per-scope grant object onto the tab booleans (build-design §1 default
    // order across → regional → cost-centre → finance). The finance TAB is the
    // whole-company /reports/finance pack — a simple boolean grant.
    const grants: Record<ReportScope, boolean> = {
      across: g.across,
      regional: g.regional !== false,
      'cost-centre': g.costCentre !== false,
      finance: g.finance,
    }
    const scopes = REPORT_SCOPES.filter((s) => grants[s])
    const defaultScope = scopes[0] ?? null

    // Month floors — MIN over the lanes (daily-cacheable, so an unscoped global
    // read is fine; the picker floor is `overall`).
    const [floors] = [
      ...(await tx.execute<FloorRow>(sql`
        SELECT (SELECT to_char(MIN(ts_event), 'YYYY-MM') FROM v_complete_usage) AS usage,
               (SELECT to_char(MIN(period_month), 'YYYY-MM') FROM v_finance_bill_totals_month) AS bill,
               (SELECT to_char(MIN(period_date), 'YYYY-MM') FROM reconciliation_record) AS reconciliation`)),
    ]
    const monthFloors = {
      usage: floors?.usage ?? null,
      bill: floors?.bill ?? null,
      reconciliation: floors?.reconciliation ?? null,
    }
    const overall =
      [monthFloors.usage, monthFloors.bill, monthFloors.reconciliation]
        .filter((m): m is string => Boolean(m))
        .sort()[0] ?? currentMonth

    // defaultRegionId — the caller's home if it is a real (non-sentinel) region,
    // else (cross-region) the first real region.
    const regionRows = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM region WHERE code <> '__unassigned__' ORDER BY display_name`)
    const realRegionIds = [...regionRows].map((r) => r.id)
    const defaultRegionId = realRegionIds.includes(session.regionId)
      ? session.regionId
      : (realRegionIds[0] ?? session.regionId)

    // Daily-cacheable (floors + provider settling config change at most daily).
    setHeader(event, 'cache-control', 'private, max-age=3600')

    return {
      scopes,
      defaultScope,
      defaultRegionId,
      monthFloors: { ...monthFloors, overall },
      providerStates: providerStatesForMonth(currentMonth, now),
      copilotMode: copilotFinanceMode(),
      // The active report-visibility policy mode — drives the "Visibility:
      // <label> · admin-configured" chip on the reports header. Only included
      // when NON-standard: the default 'standard' state is not signalled to
      // anyone (so an admin-configuration value never leaks by default), while a
      // loosened policy IS signalled by design (the chip shows for everyone). The
      // Vue chip reads `meta.value?.mode` optionally, so absence ⇒ no chip.
      ...(mode !== 'standard' ? { mode } : {}),
    }
  })
})
