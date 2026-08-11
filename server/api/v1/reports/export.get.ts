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
 * hard-branches too. `scope=region` (report = drivers | trend | practices | exposure |
 * per-developer at the clamped width; drivers | regions | concentration |
 * exposure | per-developer at `region=all`) and
 * `scope=cost-centre` (report = cards | drivers — the §A burn drill — |
 * over-soft-cap | exposure) are wired. The
 * Cost-Centre branch is dispatched BEFORE the Region zod parse so its distinct
 * report/axis enums never trip that guard. An unknown scope/report → 400.
 *
 * LEGACY SCOPE VALUES, one release. `scope=across-regions` and `scope=regional`
 * were retired by the Region merge (04-prototype-delta.md §6) and are still
 * accepted, mapped through `normaliseExportScope` — `across-regions` becomes
 * `scope=region&region=all`, `regional` becomes `scope=region` with whatever region
 * it carried. An export URL is the one reporting URL that leaves the app: it is
 * pasted into a runbook, scheduled by a script, or saved in a spreadsheet's refresh
 * settings, and none of those get rewritten when a tab is renamed. The mapping table
 * is `LEGACY_REPORT_SCOPES` in shared/reports/types.ts — the SAME table the URL state
 * and the shell map with, so a legacy value cannot resolve to two different places.
 */
import { defineEventHandler, getValidatedQuery, getQuery, setHeader, createError, type H3Event } from 'h3'
import { z } from 'zod'
import { parseSpendLens } from '../../../../shared/usage/lens'
import { requireRole, requireAuth } from '../../../auth/rbac'
import { requireReportScope, costCentreScopeOpts } from '../../../auth/report-scope'
import { withRequestRls } from '../../../db/request-rls'
import { recordAuditEvent } from '../../../db/audit'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import {
  resolveReportMonth,
  resolveReportWindow,
  DATE_REGEX,
} from '../../../reporting/params'
import type { RegionWidth } from '../../../../shared/reports/types'
import { isAllRegions, isValidRegionParam } from '../../../reporting/region-scope'
import {
  LEGACY_REPORT_SCOPES,
  isLegacyReportScope,
} from '../../../../shared/reports/types'
import {
  resolveRegionalScope,
  fetchRegionalDrivers,
  fetchRegionalTrend,
  fetchRegionalPractices,
  fetchRegionalKpis,
  fetchRegionalTierExposure,
  fetchRegionalDailyMetrics,
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
  fetchAcrossTierExposure,
  fetchAcrossDailyMetrics,
  acrossDriversToCsv,
  acrossRegionsToCsv,
  concentrationToCsv,
  ACROSS_DRIVER_AXES,
  type AcrossDriverAxis,
} from '../../../reporting/across-regions'
import { tierExposureToCsv, perDeveloperToCsv } from '../../../reporting/behaviour-csv'
import { buildPerDeveloperSeries } from '../../../../shared/reports/per-developer'
import { copilotChargebackEnabled } from '../../../reports/copilot-mode'
import { providerStatesForMonth } from '../../../reports/settling'
import { MONTH_REGEX, monthKeyUtc } from '../../../utils/period'
import { requestClock } from '../../../utils/request-clock'
import {
  fetchVisibleCostCentres,
  fetchCostCentreCards,
  resolveCostCentreDrill,
  fetchCostCentreBurnDrill,
  fetchCostCentreBurnDrivers,
  costCentreRosterScope,
  fetchCostCentreTierExposure,
  cardsToCsv,
  driversToCsv as ccDriversToCsv,
  overSoftCapToCsv,
  COST_CENTRE_DRILL_AXES,
} from '../../../reporting/cost-centres'
import { fetchOverSoftCap } from '../../../reporting/engine/over-soft-cap'
import {
  fetchFinanceCous,
  fetchFinanceBillCheck,
  financeLedgerToCsv,
  lastCompleteMonth,
} from '../../../reporting/finance'

// Loose axis/report here — each width coerces to its own valid set, so a foreign
// axis (e.g. a clamped-width axis at `region=all`) simply falls to the branch
// default rather than 400-ing on a shared enum.
const Query = z.object({
  scope: z.literal('region'),
  report: z.string().default('drivers'),
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  region: z.string().refine(isValidRegionParam, 'region must be a uuid or "all"').optional(),
  ou: z.string().uuid().optional(),
  axis: z.string().optional(),
  /*
   * The LANE, coerced (never enum-validated) exactly as the drivers endpoint
   * does — one spelling of the lens for the whole product, and a stale `?lane=`
   * in a runbook must fall back rather than 400 an export.
   *
   * IT IS LOAD-BEARING, not an echo. Once the on-screen drivers table could
   * answer the billed lane, an export that ignored `?lane=` handed a reader
   * ATTRIBUTED rows for the BILLED table they were looking at, under a filename
   * and header that named neither. The lane is now both APPLIED and STAMPED in
   * the header, because a CSV outlives the page that produced it.
   */
  lane: z.string().optional(),
  format: z.enum(['csv']).default('csv'),
})
type ExportQuery = z.infer<typeof Query>

/**
 * Map a retired `?scope=` onto the Region scope + its width, for one release.
 *
 * Returns the raw bag with `scope` (and, for `across-regions`, `region`) rewritten,
 * so the zod schema above validates ONE shape and every branch below reads one
 * vocabulary. A caller who sends both a legacy scope AND a `region` gets the
 * legacy scope's region — `across-regions` has always meant whole-company, and
 * honouring a stray `region=` beside it would narrow an export whose header says
 * whole-company.
 */
function normaliseExportScope(raw: Record<string, unknown>): Record<string, unknown> {
  const scope = typeof raw.scope === 'string' ? raw.scope : undefined
  if (!scope || !isLegacyReportScope(scope)) return raw
  const mapped = LEGACY_REPORT_SCOPES[scope]
  return {
    ...raw,
    scope: mapped.scope,
    ...(mapped.region === null ? {} : { region: mapped.region }),
  }
}

// Cost-Centre export params — a SEPARATE schema (its report/axis enums differ from
// Regional's, so there is no enum collision with the Regional Query above).
const CcQuery = z.object({
  scope: z.literal('cost-centre'),
  // `over-soft-cap` and `exposure` are DRILL reports like `drivers` — each needs
  // `cc`, and all are gated by the same resolveCostCentreDrill authorisation.
  report: z.enum(['cards', 'drivers', 'over-soft-cap', 'exposure']).default('cards'),
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  cc: z.string().uuid().optional(),
  // PROJECT, like the screen endpoint (decisions D1). An export whose default axis
  // differs from the screen's is the byte-identical rule broken at the default: the
  // same URL minus `axis` would have handed a person breakdown to someone reading a
  // project one.
  axis: z.enum(COST_CENTRE_DRILL_AXES).default('project'),
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

/**
 * WHICH teammate-grained export this is — the one audit vocabulary all four
 * teammate-labelled export paths record under.
 *
 * `width` is a Region concept and is `null` on the Cost-Centre scope;
 * `costCentreId` is the reverse. Both keys are present on every payload rather
 * than omitted per scope, so a forensic query can filter on either without
 * knowing which shape it is about to meet.
 */
interface TeammateExportCtx {
  actorTeammateId: string
  scope: 'region' | 'cost-centre'
  width: RegionWidth | null
  costCentreId: string | null
  report: 'drivers' | 'over-soft-cap'
}

/**
 * OPERATIONAL PROVENANCE for the teammate-labelled exports — one `event_type`
 * and one payload shape for all four paths.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. It answers "who pulled this export, when, at
 * what scope, and how big was it" — the question an operator asks when a
 * spreadsheet of somebody's numbers turns up in a meeting and nobody remembers
 * generating it, or when a report needs reproducing as it stood on a given day.
 * It is NOT a privacy or disclosure control and must not be described as one:
 * these exports carry nothing a caller could not already read on screen, and
 * what a caller may read at all is decided upstream by `requireReportScope`,
 * which clamps the scope, fails closed and writes its own deny-audit. This
 * record is written AFTER that decision has already gone the caller's way; it
 * describes a permitted read rather than restraining one.
 *
 * The payload carries COUNTS AND IDS ONLY — not because the labels are
 * sensitive, but because an audit row is a record of the ACT, not a copy of its
 * output. Duplicating every exported row here would grow the audit log by the
 * size of the report on every download and make the trail harder to read for the
 * one question it exists to answer.
 *
 * `rowCount` is the number of teammate rows the file carried. Exports are not
 * truncated, so it is also the size of the population the caller's scope
 * authorised at that moment — the figure that makes one export comparable to the
 * next.
 *
 * `axis: 'teammate'` is constant, including on `over-soft-cap`, which takes no
 * axis parameter: the axis names the GRAIN of the file, and that report is one
 * row per teammate.
 */
async function recordTeammateExportAudit(
  tx: PostgresJsDatabase<Record<string, unknown>>,
  ctx: TeammateExportCtx,
  stats: { rowCount: number },
): Promise<void> {
  await recordAuditEvent(tx, {
    eventType: 'report-export-teammate-axis',
    actorTeammateId: ctx.actorTeammateId,
    actorSystem: 'reports-export',
    // Resource-anchored where a resource exists: the Cost-Centre doors export ONE
    // centre's people, and which centre is the first thing an investigator asks.
    subjectKind: ctx.costCentreId ? 'cost-centre' : 'report-scope',
    subjectId: ctx.costCentreId,
    payload: {
      scope: ctx.scope,
      width: ctx.width,
      costCentreId: ctx.costCentreId,
      report: ctx.report,
      axis: 'teammate',
      rowCount: stats.rowCount,
    },
  })
}

function respondCsv(event: H3Event, csv: string | null, filename: string): string {
  if (!csv) throw createError({ statusCode: 400, statusMessage: 'unsupported report' })
  setHeader(event, 'content-type', 'text/csv; charset=utf-8')
  setHeader(event, 'content-disposition', `attachment; filename="${filename}"`)
  return csv
}

export default defineEventHandler(async (event) => {
  const raw = normaliseExportScope(getQuery(event) as Record<string, unknown>)
  // Cost-Centre (Wave 3) — a self-contained branch (its RBAC + params + serialisers
  // all differ from Region's). Dispatched before the Region zod parse so
  // `scope=cost-centre` never trips the `z.literal('region')` guard.
  if (raw.scope === 'cost-centre') {
    return await costCentreExport(event)
  }
  // Finance (Wave 5) — the ledger; its report/region params + global-only gate differ
  // from the others. Dispatched before the Region zod parse (finance is not that
  // literal) so it never trips the `z.literal('region')` guard.
  if (raw.scope === 'finance') {
    return await financeExport(event)
  }

  const query = Query.parse(raw)
  // ONE scope, two widths — `region=all` is the whole-company export that used to be
  // `scope=across-regions`, and it is the width, not a different scope, that picks
  // the query fns and the gate.
  return isAllRegions(query.region)
    ? await exportAllRegions(event, query)
    : await exportOneRegion(event, query)
})

// ── Region, clamped width (was `scope=regional`) — behaviour preserved exactly ─
async function exportOneRegion(event: H3Event, query: ExportQuery): Promise<string> {
  // ONE clock for this request (F1/D1) — the CSV's series edge is the SAME
  // settled edge the screen draws, so an export never carries a day the chart
  // refused to claim.
  const clock = requestClock(event)
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
  const win = resolveReportWindow(query, { now: new Date(clock.now) })
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))
  // Unnamed / foreign axis falls back to PROJECT — the same default the screen
  // endpoint applies (decisions D1), so the CSV opens on the same breakdown.
  const axis: RegionalDriverAxis = (REGIONAL_DRIVER_AXES as readonly string[]).includes(
    query.axis ?? '',
  )
    ? (query.axis as RegionalDriverAxis)
    : 'project'
  // The lane the SCREEN was showing. Applied, not just echoed — see the `lane`
  // note on the query schema.
  const lens = parseSpendLens(query.lane)

  const { csv, filename } = await withRequestRls(event, async (tx) => {
    // Thread the report-visibility grant so a loosened mode lets an elevated admin /
    // cost-centre owner export cross-region (grant is a level, not a bypass — the
    // resolver still clamps to the honoured region). `requireReportScope` is the same
    // tab gate the screen endpoints apply, so a caller with `regional: false` is a
    // 403 here too rather than an export of their home region's figures.
    const { grants } = await requireReportScope(event, tx, 'region', { width: 'region' })
    const scope = await resolveRegionalScope(
      tx,
      caller,
      { region: query.region, ou: query.ou },
      { crossRegion: grants.regional === 'all-regions' },
    )
    /*
     * WHAT THE ROWS BELOW WERE ACTUALLY CLAMPED TO, in words — taken from the
     * resolver that built the predicate (`scope.scopeLabel`), never re-derived
     * here. `drill ?? region` is right for an admin, whose clause IS `region_id
     * = …`, and wrong for a manager or a developer, whose §A clamp is their own
     * `app.user_org_path` subtree: the header named a whole region over one
     * team's rows. That is contract C11, and the on-screen coverage note already
     * moved to `scope.scopeLabel` for it — this export was running on its own
     * copy of the same wrong derivation.
     *
     * `null` is the resolver's explicit "the subtree clamp resolved to no org
     * unit at all" state, so there is no scope to name and the header says that
     * rather than falling back to the region — the fallback being the defect.
     */
    const scopeLabel = scope.scopeLabel ?? 'no resolved scope'
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
    // The two behaviour cards. Same primitives as `/reports/regional/behaviour`,
    // so the CSV cannot re-derive a figure the screen computed differently.
    if (query.report === 'exposure') {
      const exposure = await fetchRegionalTierExposure(tx, scope, win)
      return {
        csv: tierExposureToCsv(exposure, { scopeLabel, asOfDate }),
        filename: `tokenscope-regional-exposure-${slug}-${month}.csv`,
      }
    }
    if (query.report === 'per-developer') {
      const daily = await fetchRegionalDailyMetrics(tx, scope, win, clock)
      return {
        csv: perDeveloperToCsv(
          buildPerDeveloperSeries(daily, { from: win.from, to: win.to }),
          { scopeLabel, asOfDate },
        ),
        filename: `tokenscope-regional-per-developer-${slug}-${month}.csv`,
      }
    }
    // drivers (default)
    const drivers = await fetchRegionalDrivers(tx, scope, win, axis, lens, {
      copilotChargeback: copilotChargebackEnabled(),
    })
    const { rows, lane, chargebackCoverage, billedLane } = drivers
    if (axis === 'teammate') {
      // Provenance only — the file itself is exactly what the caller's scope
      // authorised, every row of it.
      await recordTeammateExportAudit(tx, {
        actorTeammateId: caller.teammateId,
        scope: 'region',
        width: 'region',
        costCentreId: null,
        report: 'drivers',
      }, { rowCount: rows.length })
    }
    return {
      csv: driversToCsv(rows, {
        month,
        asOfDate,
        axis,
        scopeLabel,
        lane,
        billedLane,
        chargebackCoverage,
      }),
      filename: `tokenscope-regional-drivers-${axis}-${slug}-${month}.csv`,
    }
  })

  return respondCsv(event, csv, filename)
}

// ── Region, whole-company width (was `scope=across-regions`) ─────────────────
async function exportAllRegions(event: H3Event, query: ExportQuery): Promise<string> {
  // ONE clock for this request (F1/D1) — see exportOneRegion.
  const clock = requestClock(event)
  // Month OR custom from/to window — the SAME window the screen endpoints use. In range
  // mode the drivers/regions/concentration queries window the WHOLE range, so the CSV
  // stays byte-identical to the range-windowed screen figures. Month mode is byte-identical
  // to the old resolveReportMonth path.
  const win = resolveReportWindow(query, { now: new Date(clock.now) })
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))
  // Unnamed / foreign axis falls back to PROJECT — the same default the screen
  // endpoint applies (decisions D1), so the CSV opens on the same breakdown.
  const axis: AcrossDriverAxis = (ACROSS_DRIVER_AXES as readonly string[]).includes(query.axis ?? '')
    ? (query.axis as AcrossDriverAxis)
    : 'project'
  const lens = parseSpendLens(query.lane)

  const { csv, filename } = await withRequestRls(event, async (tx) => {
    // The whole-company width — gated on `across`, deny audited, exactly as the
    // retired `/reports/export?scope=across-regions` gate was.
    const { session } = await requireReportScope(event, tx, 'region', { width: 'all-regions' })
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
    // The two behaviour cards. Same primitives as
    // `/reports/across-regions/behaviour`, so the CSV cannot re-derive a figure
    // the screen computed differently.
    if (query.report === 'exposure') {
      const exposure = await fetchAcrossTierExposure(tx, win)
      return {
        csv: tierExposureToCsv(exposure, { scopeLabel: 'the whole company', asOfDate }),
        filename: `tokenscope-across-regions-exposure-${month}.csv`,
      }
    }
    if (query.report === 'per-developer') {
      const daily = await fetchAcrossDailyMetrics(tx, win, clock)
      return {
        csv: perDeveloperToCsv(
          buildPerDeveloperSeries(daily, { from: win.from, to: win.to }),
          { scopeLabel: 'the whole company', asOfDate },
        ),
        filename: `tokenscope-across-regions-per-developer-${month}.csv`,
      }
    }
    // drivers (default)
    const drivers = await fetchAcrossDrivers(tx, win, axis, lens, {
      copilotChargeback: copilotChargebackEnabled(),
    })
    const { lane, chargebackCoverage, rows, billedLane } = drivers
    if (axis === 'teammate') {
      /*
       * The WIDEST population in the product — `region=all` on the teammate axis
       * is every teammate in the company, ranking and provider arms alike. Which
       * is exactly why the provenance record matters most here: it is the widest
       * read the `all-regions` grant permits, and `width` in the payload is what
       * distinguishes it from a single-region pull after the fact.
       */
      await recordTeammateExportAudit(tx, {
        actorTeammateId: session.teammateId,
        scope: 'region',
        width: 'all-regions',
        costCentreId: null,
        report: 'drivers',
      }, { rowCount: rows.length })
    }
    return {
      csv: acrossDriversToCsv(rows, {
        month,
        asOfDate,
        axis,
        lane,
        billedLane,
        chargebackCoverage,
      }),
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
 *   - report=over-soft-cap → the same drill gate, but a ROSTER-anchored population
 *     (teammate placement), so its rows do NOT reconcile to the CC burn and its
 *     header names its own denominator instead.
 */
async function costCentreExport(event: H3Event): Promise<string> {
  const session = await requireAuth(event)
  const query = await getValidatedQuery(event, (d) => CcQuery.parse(d))
  const now = new Date(requestClock(event).now)
  // Month OR custom from/to window — the SAME window the tracker/drill screen uses. In
  // range mode the burn/drivers window the WHOLE range (so the CSV is byte-identical to
  // the range-windowed screen); the month-anchored card mechanics (forecast/exhaustion)
  // are null off a month, exactly as the index computes them. Month mode is byte-identical.
  const win = resolveReportWindow(query, { now })
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))
  const monthCtx = win.isMonth && win.monthStr ? { month: win.monthStr, now } : null

  const { csv, filename } = await withRequestRls(event, async (tx) => {
    // S3 part (d): the missing deny arm — WITHOUT this, a caller whose
    // grants.costCentre === false (denied entirely, not just un-elevated) fell
    // through to fetchVisibleCostCentres' owner/subtree predicate and got a
    // silent EMPTY 200 instead of an explicit 403. requireReportScope resolves
    // the SAME grants resolveReportGrants would, so this replaces (not
    // duplicates) that call.
    const { grants } = await requireReportScope(event, tx, 'cost-centre')
    // An ACTIVE 'operational' report-access grant (grants.costCentre === 'all')
    // unbounds the visible set + the drill; `costCentreScopeOpts` also seals the
    // org-wide-baseline seam (A3, mig 0129) — see its own comment in
    // server/auth/report-scope.ts. Non-elevated callers keep the owner/subtree
    // predicate, unchanged.
    const ccOpts = costCentreScopeOpts(session, grants)

    if (query.report === 'cards') {
      const ccs = await fetchVisibleCostCentres(tx, ccOpts)
      const { cards, asOfDate } = await fetchCostCentreCards(tx, ccs, win, monthCtx, {
        copilotChargeback: copilotChargebackEnabled(),
      })
      return {
        csv: cardsToCsv(cards, { month, asOfDate }),
        filename: `tokenscope-cost-centres-${month}.csv`,
      }
    }

    // Both DRILL reports need a cc, resolved + authorised the same way (anti-IDOR).
    // The drill reports — resolve + authorise the CC first (anti-IDOR).
    if (!query.cc) throw createError({ statusCode: 400, statusMessage: 'cc required for this report' })
    const cc = await resolveCostCentreDrill(tx, session, query.cc, ccOpts)
    const slug = cc.code.replace(/[^a-z0-9-]/gi, '')

    /*
     * Over the soft cap — the SAME query fn the screen calls, over the SAME
     * roster clamp, so the file and the card cannot disagree (byte-identical rule).
     * Its population is teammate PLACEMENT, not the `cost_owning_unit_id` burn axis
     * the drivers report below uses; the header states its own denominator so the
     * two files are never read as slices of one number.
     */
    if (query.report === 'over-soft-cap') {
      const data = await fetchOverSoftCap(tx, await costCentreRosterScope(tx, cc.id), win)
      /*
       * A teammate-grained file, so it takes the same provenance record the
       * drivers exports do — `report` distinguishes the two, and `costCentreId`
       * anchors it to the centre whose roster it named. Who may pull it at all
       * was already settled by `resolveCostCentreDrill` above.
       */
      await recordTeammateExportAudit(
        tx,
        {
          actorTeammateId: session.teammateId,
          scope: 'cost-centre',
          width: null,
          costCentreId: cc.id,
          report: 'over-soft-cap',
        },
        { rowCount: data.over.length },
      )
      return {
        csv: overSoftCapToCsv(data, { month, ccLabel: cc.displayName }),
        filename: `tokenscope-cost-centre-over-soft-cap-${slug}-${month}.csv`,
      }
    }

    /*
     * Behavioural exposure — the §B billed lane, beside the §A reports above and
     * never summed with them. Its own file, so a reader cannot take a band as a
     * slice of the burn.
     */
    if (query.report === 'exposure') {
      const exposure = await fetchCostCentreTierExposure(tx, cc.id, win)
      return {
        csv: tierExposureToCsv(exposure, { scopeLabel: cc.displayName, asOfDate: null }),
        filename: `tokenscope-cost-centre-exposure-${slug}-${month}.csv`,
      }
    }

    const burn = await fetchCostCentreBurnDrill(tx, cc.id, win)
    const drivers = await fetchCostCentreBurnDrivers(tx, cc.id, win, query.axis, burn.burnUsd)
    const rows = drivers.rows
    if (query.axis === 'teammate') {
      /*
       * The §A burn drill on the teammate axis — one row per person, so it takes
       * the provenance record. The other three axes (project / model / surface)
       * label things rather than people: there is no teammate grain to record, so
       * they write nothing — see the audit-free assertion in
       * tests/integration/reports/cost-centres.test.ts.
       */
      await recordTeammateExportAudit(tx, {
        actorTeammateId: session.teammateId,
        scope: 'cost-centre',
        width: null,
        costCentreId: cc.id,
        report: 'drivers',
      }, { rowCount: rows.length })
    }
    return {
      csv: ccDriversToCsv(rows, {
        month,
        asOfDate: burn.asOf,
        axis: query.axis,
        ccLabel: cc.displayName,
      }),
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
  const now = new Date(requestClock(event).now)
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
