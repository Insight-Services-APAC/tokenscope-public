/*
 * GET /api/v1/reports/finance?month&region — the FINANCE (end-of-month) reporting
 * scope: the chargeback pack global finance validates the bill against and x-charges
 * from (docs/design/reporting-consolidation/00-build-design.md §2/§3, Wave 5).
 *
 * READS (build-design §4 lane matrix, §B bill lanes):
 *   - per-CoU chargeback → `v_finance_chargeback_month` (Anthropic month-rolled ∪
 *     Copilot per-org pooled net); the NULL-CoU unallocated bucket is retained.
 *   - the VISIBLE Σ=bill check → Σ chargeback vs `v_finance_bill_totals_month`
 *     (each provider from EXACTLY one authoritative surface). A mismatch OR an
 *     UNSETTLED month shows RED "unsettled" — never a silent pass (§7(1), risk 7).
 *   - exempt gap → indicative usage lane (`v_complete_usage`) − chargeback (NOT
 *     showback−chargeback; exempt orgs are never on bill surfaces — violation 4).
 * `copilot.mode`: chargeback-mode folds the Copilot pooled net; pool-utilisation
 * mode holds it back ("pending correct writer") — build-design §6.
 *
 * DEFAULT MONTH = the LAST COMPLETE month (you cannot chargeback an in-progress one).
 *
 * RBAC (owner-decisions D-Q5): Finance is a GLOBAL function — gate on
 * `global-finops` + `platform-admin` ONLY. The zombie `finance` enum member is NOT a
 * gate (it 403s here). `region` is a convenience filter over the CoU table, NEVER a
 * gate relaxation (global-finops already sees every region; platform-admin passes any
 * gate). The Σ=bill reconciliation + exempt gap stay whole-company regardless.
 *
 * HOMING (D-Homing): current-org interim — every finance surface carries the
 * "homed to current org structure" disclosure (see server/reporting/finance.ts).
 *
 * No `attribution_record` / raw `actual_spend` (the lane firewall, §7(7)).
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import {
  fetchFinanceBillCheck,
  fetchFinanceCous,
  fetchFinanceExemptGap,
  lastCompleteMonth,
  HOMING_NOTE,
} from '../../../../reporting/finance'
import { providerStatesForWindow } from '../../../../reports/settling'
import { copilotChargebackEnabled, copilotFinanceMode } from '../../../../reports/copilot-mode'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'
import type { ReportMeta } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  region: z.string().uuid().optional(),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'global-finops', 'platform-admin')
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const now = new Date()
  // Month OR custom from/to window. The bill/chargeback surfaces are MONTH-GRAINED
  // (`period_month`): a custom sub-month range picks up the whole `period_month`s it
  // spans (`period_month >= from-month AND < to-month+1`) — the same convention the
  // Across bill query uses. When no month/range is given, Finance still defaults to
  // the LAST COMPLETE month (you cannot chargeback an in-progress one). Month mode is
  // byte-identical to the old path.
  const win = resolveReportWindow(
    { ...query, month: query.month ?? (query.from || query.to ? undefined : lastCompleteMonth(now)) },
    { now },
  )
  const metaMonth = win.monthStr ?? monthKeyUtc(new Date(win.startIso))
  const copilotChargeback = copilotChargebackEnabled()
  const region = query.region ?? null

  return await withRequestRls(event, async (tx) => {
    const billCheck = await fetchFinanceBillCheck(tx, win)
    const cous = await fetchFinanceCous(tx, win, { copilotChargeback, region })
    const exemptGap = await fetchFinanceExemptGap(tx, win, { region })

    // asOf provenance — the usage lane's freshness for the window (a stamp, not a figure).
    const [asOf] = [
      ...(await tx.execute<{ as_of: string | null }>(sql`
        SELECT to_char(MAX(ts_event), 'YYYY-MM-DD') AS as_of
        FROM v_complete_usage
        WHERE ts_event >= ${win.startIso}::timestamptz
          AND ts_event <  ${win.endIso}::timestamptz`)),
    ]

    const meta: ReportMeta = {
      month: metaMonth,
      monthFloor: metaMonth,
      asOfDate: asOf?.as_of ?? null,
      providerStates: providerStatesForWindow(win, now),
      scope: 'finance',
      // Finance homes bill rows to the CURRENT org structure (D-Homing interim).
      pointInTimeDims: false,
      ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
    }

    return {
      meta,
      billCheck,
      cous,
      copilot: {
        mode: copilotFinanceMode(),
        // Held back with a "pending correct writer" marker until Wave 0 validates on Dev.
        pending: !copilotChargeback,
      },
      exemptGap,
      region,
      homingNote: HOMING_NOTE,
    }
  })
})
