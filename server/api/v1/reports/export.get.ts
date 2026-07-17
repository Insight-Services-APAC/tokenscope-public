/*
 * GET /api/v1/reports/export?scope&report&month&…&format=csv — the shared CSV
 * export for the reporting scopes (build-design §2, owner-decisions D-Q8).
 *
 * BYTE-IDENTICAL rule (build-design §2): the export calls the SAME query fns as
 * the screen endpoints, then serialises. It never re-derives figures, so the CSV
 * cannot drift from what the user sees. RBAC is DELEGATED per scope: Regional
 * uses resolveRegionalScope (incl. the `ou` anti-IDOR); Across-Regions is
 * whole-company (global-finops / platform-admin only); Cost-Centre delegates to
 * the CC ownership/region gate (fetchVisibleCostCentres / resolveCostCentreDrill).
 * CSVs stamp `asOfDate` (owner gate fold-in). Lane firewall: §7(7).
 *
 * There is no registry (Wave 2's delegator hard-branches on scope); this file
 * hard-branches too. `scope=regional` (report = drivers | trend | practices),
 * `scope=across-regions` (report = drivers | regions | concentration) and
 * `scope=cost-centre` (report = cards | drivers — the §A burn drill) are wired. The
 * Cost-Centre branch is dispatched BEFORE the Regional/Across zod parse so its
 * distinct report/axis enums never trip the `['regional','across-regions']` guard.
 * An unknown scope/report → 400.
 */
import { defineEventHandler, getValidatedQuery, getQuery, setHeader, createError, type H3Event } from 'h3'
import { z } from 'zod'
import { requireRole, requireAuth } from '../../../auth/rbac'
import { requireReportScope, resolveReportGrants } from '../../../auth/report-scope'
import { withRequestRls } from '../../../db/request-rls'
import { resolveReportMonth, resolveReportWindow, DATE_REGEX } from '../../../reporting/params'
import {
  resolveRegionalScope,
  fetchRegionalDrivers,
  fetchRegionalTrend,
  fetchRegionalPractices,
  fetchRegionalKpis,
  driversToCsv,
  trendToCsv,
  practicesToCsv,
  REGIONAL_DRIVER_AXES,
  type RegionalDriverAxis,
} from '../../../reporting/regional'
import {
  fetchAcrossDrivers,
  fetchAcrossRegionCards,
  fetchAcrossKpis,
  fetchConcentration,
  acrossDriversToCsv,
  acrossRegionsToCsv,
  concentrationToCsv,
  ACROSS_DRIVER_AXES,
  type AcrossDriverAxis,
} from '../../../reporting/across-regions'
import { copilotChargebackEnabled } from '../../../reports/copilot-mode'
import { providerStatesForMonth } from '../../../reports/settling'
import { MONTH_REGEX, monthKeyUtc } from '../../../utils/period'
import {
  fetchVisibleCostCentres,
  fetchCostCentreCards,
  resolveCostCentreDrill,
  fetchCostCentreBurnDrill,
  fetchCostCentreBurnDrivers,
  cardsToCsv,
  driversToCsv as ccDriversToCsv,
  COST_CENTRE_DRILL_AXES,
} from '../../../reporting/cost-centres'
import {
  fetchFinanceCous,
  fetchFinanceBillCheck,
  financeLedgerToCsv,
  lastCompleteMonth,
} from '../../../reporting/finance'

// Loose axis/report here — each scope branch coerces to its own valid set, so a
// foreign axis (e.g. a regional axis on across-regions) simply falls to the branch
// default rather than 400-ing on a shared enum.
const Query = z.object({
  scope: z.enum(['regional', 'across-regions']),
  report: z.string().default('drivers'),
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  region: z.string().uuid().optional(),
  ou: z.string().uuid().optional(),
  axis: z.string().optional(),
  format: z.enum(['csv']).default('csv'),
})
type ExportQuery = z.infer<typeof Query>

// Cost-Centre export params — a SEPARATE schema (its report/axis enums differ from
// Regional's, so there is no enum collision with the Regional Query above).
const CcQuery = z.object({
  scope: z.literal('cost-centre'),
  report: z.enum(['cards', 'drivers']).default('cards'),
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  cc: z.string().uuid().optional(),
  axis: z.enum(COST_CENTRE_DRILL_AXES).default('teammate'),
  format: z.enum(['csv']).default('csv'),
})

// Finance export params (Wave 5) — the LEDGER only (cost-centre × provider × month,
// owner D-Q8). A SEPARATE schema; `finance` is not in the Regional/Across enum.
const FinanceQuery = z.object({
  scope: z.literal('finance'),
  report: z.enum(['ledger']).default('ledger'),
  month: z.string().regex(MONTH_REGEX).optional(),
  region: z.string().uuid().optional(),
  format: z.enum(['csv']).default('csv'),
})

function respondCsv(event: H3Event, csv: string | null, filename: string): string {
  if (!csv) throw createError({ statusCode: 400, statusMessage: 'unsupported report' })
  setHeader(event, 'content-type', 'text/csv; charset=utf-8')
  setHeader(event, 'content-disposition', `attachment; filename="${filename}"`)
  return csv
}

export default defineEventHandler(async (event) => {
  // Cost-Centre (Wave 3) — a self-contained branch (its RBAC + params + serialisers
  // all differ from Regional's). Dispatched before the Regional/Across zod parse so
  // `scope=cost-centre` never trips the `z.enum(['regional','across-regions'])` guard.
  if (getQuery(event).scope === 'cost-centre') {
    return await costCentreExport(event)
  }
  // Finance (Wave 5) — the ledger; its report/region params + global-only gate differ
  // from the others. Dispatched before the Regional/Across zod parse (finance is not
  // in that scope enum) so it never trips the `z.enum(['regional','across-regions'])`.
  if (getQuery(event).scope === 'finance') {
    return await financeExport(event)
  }

  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  return query.scope === 'across-regions'
    ? await exportAcrossRegions(event, query)
    : await exportRegional(event, query)
})

// ── Regional (Wave 2) — behaviour preserved exactly ──────────────────────────
async function exportRegional(event: H3Event, query: ExportQuery): Promise<string> {
  const caller = await requireRole(
    event,
    'developer',
    'manager',
    'admin',
    'global-finops',
    'platform-admin',
  )
  // Month OR custom from/to window — the SAME window the screen endpoints use
  // (resolveReportWindow). In range mode the driver/trend/practices queries window the
  // WHOLE range, so the CSV stays byte-identical to the range-windowed screen figures.
  // Month mode is byte-identical to the old resolveReportMonth path.
  const win = resolveReportWindow(query)
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))
  const axis: RegionalDriverAxis = (REGIONAL_DRIVER_AXES as readonly string[]).includes(
    query.axis ?? '',
  )
    ? (query.axis as RegionalDriverAxis)
    : 'teammate'

  const { csv, filename } = await withRequestRls(event, async (tx) => {
    // Thread the report-visibility grant so a loosened mode lets an elevated admin /
    // cost-centre owner export cross-region (grant is a level, not a bypass — the
    // resolver still clamps to the honoured region).
    const grants = await resolveReportGrants(event, tx, caller)
    const scope = await resolveRegionalScope(
      tx,
      caller,
      { region: query.region, ou: query.ou },
      { crossRegion: grants.regional === 'all-regions' },
    )
    const scopeLabel = scope.ou?.displayName ?? scope.region?.displayName ?? 'scope'
    // asOfDate is the same MAX(ts_event) the screen KPIs stamp (one shared source).
    const kpis = await fetchRegionalKpis(tx, scope, win, {
      copilotChargeback: copilotChargebackEnabled(),
    })
    const asOfDate = kpis.asOfDate
    const slug = (scope.region?.code ?? 'region').replace(/[^a-z0-9-]/gi, '')

    if (query.report === 'trend') {
      const { series } = await fetchRegionalTrend(tx, scope, win)
      return {
        csv: trendToCsv(series, { month, asOfDate, scopeLabel }),
        filename: `tokenscope-regional-trend-${slug}-${month}.csv`,
      }
    }
    if (query.report === 'practices') {
      const rows = await fetchRegionalPractices(tx, scope, win)
      return {
        csv: practicesToCsv(rows, { month, asOfDate, scopeLabel }),
        filename: `tokenscope-regional-practices-${slug}-${month}.csv`,
      }
    }
    // drivers (default)
    const { rows } = await fetchRegionalDrivers(tx, scope, win, axis)
    return {
      csv: driversToCsv(rows, { month, asOfDate, axis, scopeLabel }),
      filename: `tokenscope-regional-drivers-${axis}-${slug}-${month}.csv`,
    }
  })

  return respondCsv(event, csv, filename)
}

// ── Across-Regions (Wave 4) — whole-company, global-finops / platform-admin ──
async function exportAcrossRegions(event: H3Event, query: ExportQuery): Promise<string> {
  // Month OR custom from/to window — the SAME window the screen endpoints use. In range
  // mode the drivers/regions/concentration queries window the WHOLE range, so the CSV
  // stays byte-identical to the range-windowed screen figures. Month mode is byte-identical
  // to the old resolveReportMonth path.
  const win = resolveReportWindow(query)
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))
  const axis: AcrossDriverAxis = (ACROSS_DRIVER_AXES as readonly string[]).includes(query.axis ?? '')
    ? (query.axis as AcrossDriverAxis)
    : 'region'

  const { csv, filename } = await withRequestRls(event, async (tx) => {
    await requireReportScope(event, tx, 'across')
    // asOfDate is the same MAX(ts_event) the screen KPIs stamp (one shared source).
    const kpis = await fetchAcrossKpis(tx, win, {
      copilotChargeback: copilotChargebackEnabled(),
    })
    const asOfDate = kpis.asOfDate

    if (query.report === 'regions') {
      const cards = await fetchAcrossRegionCards(tx, win, {
        copilotChargeback: copilotChargebackEnabled(),
      })
      return {
        csv: acrossRegionsToCsv(cards, { month, asOfDate }),
        filename: `tokenscope-across-regions-regions-${month}.csv`,
      }
    }
    if (query.report === 'concentration') {
      const stats = await fetchConcentration(tx, win)
      return {
        csv: concentrationToCsv(stats, { month, asOfDate }),
        filename: `tokenscope-across-regions-concentration-${month}.csv`,
      }
    }
    // drivers (default)
    const { rows } = await fetchAcrossDrivers(tx, win, axis)
    return {
      csv: acrossDriversToCsv(rows, { month, asOfDate, axis }),
      filename: `tokenscope-across-regions-drivers-${axis}-${month}.csv`,
    }
  })

  return respondCsv(event, csv, filename)
}

/**
 * Cost-Centre CSV export (Wave 3). Reuses the SAME query fns as the screen
 * endpoints (byte-identical rule) and DELEGATES RBAC to the scope resolvers:
 *   - report=cards → the visible-CC grid (fetchVisibleCostCentres, requireAuth).
 *   - report=drivers → the §A BURN drill for `cc` (teammate|model), gated by
 *     resolveCostCentreDrill (owner OR requireRegionScope; foreign/unowned → 403;
 *     missing → 404). Rows reconcile to the CC burn — the SAME lane as the tracker.
 */
async function costCentreExport(event: H3Event): Promise<string> {
  const session = await requireAuth(event)
  const query = await getValidatedQuery(event, (d) => CcQuery.parse(d))
  const now = new Date()
  // Month OR custom from/to window — the SAME window the tracker/drill screen uses. In
  // range mode the burn/drivers window the WHOLE range (so the CSV is byte-identical to
  // the range-windowed screen); the month-anchored card mechanics (forecast/exhaustion)
  // are null off a month, exactly as the index computes them. Month mode is byte-identical.
  const win = resolveReportWindow(query, { now })
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))
  const monthCtx = win.isMonth && win.monthStr ? { month: win.monthStr, now } : null

  const { csv, filename } = await withRequestRls(event, async (tx) => {
    // A loosened policy mode (reportGrants.costCentre === 'all') unbounds the visible
    // set + the drill; non-elevated callers keep the owner/subtree predicate.
    const grants = await resolveReportGrants(event, tx, session)
    const unbounded = grants.costCentre === 'all'

    if (query.report === 'cards') {
      const ccs = await fetchVisibleCostCentres(tx, { unbounded })
      const { cards, asOfDate } = await fetchCostCentreCards(tx, ccs, win, monthCtx, {
        copilotChargeback: copilotChargebackEnabled(),
      })
      return {
        csv: cardsToCsv(cards, { month, asOfDate }),
        filename: `tokenscope-cost-centres-${month}.csv`,
      }
    }

    // drivers (the only drill report) — resolve + authorise the CC (anti-IDOR).
    if (!query.cc) throw createError({ statusCode: 400, statusMessage: 'cc required for this report' })
    const cc = await resolveCostCentreDrill(tx, event, session, query.cc, { unbounded })
    const slug = cc.code.replace(/[^a-z0-9-]/gi, '')

    const burn = await fetchCostCentreBurnDrill(tx, cc.id, win)
    const { rows } = await fetchCostCentreBurnDrivers(tx, cc.id, win, query.axis, burn.burnUsd)
    return {
      csv: ccDriversToCsv(rows, { month, asOfDate: burn.asOf, axis: query.axis, ccLabel: cc.displayName }),
      filename: `tokenscope-cost-centre-drivers-${query.axis}-${slug}-${month}.csv`,
    }
  })

  return respondCsv(event, csv, filename)
}

/**
 * Finance ledger CSV export (Wave 5, owner D-Q8). Grain cost-centre × provider ×
 * month. DELEGATES to the finance gate — `global-finops` + `platform-admin` ONLY
 * (D-Q5); the zombie `finance` enum 403s. Reuses the SAME per-CoU query fn as the
 * screen (byte-identical) + the Σ=bill check for the header stamp. Default month =
 * the last complete month. asOf-stamped via the ledger header.
 */
async function financeExport(event: H3Event): Promise<string> {
  const query = await getValidatedQuery(event, (d) => FinanceQuery.parse(d))
  const now = new Date()
  const { month, range } = resolveReportMonth(query.month ?? lastCompleteMonth(now), { now })
  const copilotChargeback = copilotChargebackEnabled()
  const region = query.region ?? null

  const csv = await withRequestRls(event, async (tx) => {
    // Whole-company finance ledger — same cross-region gate as /reports/finance.
    await requireReportScope(event, tx, 'finance')
    const cous = await fetchFinanceCous(tx, range, { copilotChargeback, region })
    const check = await fetchFinanceBillCheck(tx, range)
    const states = providerStatesForMonth(month, now)
    const anthropicState = states.find((s) => s.vendor === 'anthropic')?.state ?? 'estimated'
    const githubState = states.find((s) => s.vendor === 'github')?.state ?? 'estimated'
    return financeLedgerToCsv(cous, { month, asOfDate: null, anthropicState, githubState, check })
  })

  return respondCsv(event, csv, `tokenscope-finance-ledger-${month}.csv`)
}
