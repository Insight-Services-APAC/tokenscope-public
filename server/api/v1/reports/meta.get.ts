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
import { isPlatformAdmin } from '../../../../shared/auth/roles'
import { withRequestRls } from '../../../db/request-rls'
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
  const role = session.role
  const crossRegion = role === 'global-finops' || isPlatformAdmin(role)
  const now = new Date()
  const currentMonth = monthKeyUtc(now)

  return await withRequestRls(event, async (tx) => {
    // CC ownership (a RELATIONSHIP, not a role) grants the Cost-Centre scope.
    const [own] = [
      ...(await tx.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n FROM cou_owner co
        JOIN org_unit ou ON ou.id = co.org_unit_id
        WHERE co.teammate_id = ${session.teammateId}::uuid
          AND co.revoked_at IS NULL AND ou.retired_at IS NULL`)),
    ]
    const ownsCostCentre = Number(own?.n ?? 0) > 0

    // Granted scopes (build-design §1 default order across → regional → cost-centre → finance).
    const canManage = role === 'manager' || role === 'admin' || crossRegion
    const grants: Record<ReportScope, boolean> = {
      across: crossRegion,
      regional: role === 'developer' || canManage,
      'cost-centre': ownsCostCentre || canManage,
      // Finance is a GLOBAL function (owner-decisions D-Q5): global-finops +
      // platform-admin ONLY — no region-finance path, and the zombie `finance` enum
      // is NOT a grant. Matches the `GET /reports/finance` endpoint gate (Wave 5).
      finance: crossRegion,
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
    }
  })
})
