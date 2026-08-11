/*
 * GET /api/v1/admin/teammates?region={regionId}&limit=N&offset=M
 *      &placement=all|unplaced|placed
 * — region-scoped teammates list for the admin Teammates tab
 * (design-notes §Screen 5), and the worklist behind "Unplaced · N teammates".
 *
 * Surfaces email, display name, org-unit path, source (SCIM / manual / CSV),
 * the two directory attributes this estate actually populates, and the
 * teammate's chargeable spend in the active window.
 *
 * ── THE PLACEMENT FILTER (C1) ─────────────────────────────────────────────
 * `unplaced` means "homed on a HOLDING node", tested on `unit_type`, never on
 * the code. shared/placement/holding-nodes.ts is explicit that the unit_type is
 * the classification key — "a holding node is defined by BEING a holding node,
 * and a tenant that mints a second one under a different code must still be
 * recognised as not a real placement". A filter keyed on `__UNPLACED__` would
 * silently under-report the moment a second holding node exists.
 *
 * `total` follows the filter and `unfiltered_total` does not, so the tab can say
 * "290 of 513" — one of those numbers alone cannot.
 *
 * ── THE DIRECTORY COLUMNS (C3) ────────────────────────────────────────────
 * `department` / `company_name` are read from the directory SNAPSHOT captured on
 * teammate.metadata by the placement lanes (server/reconciliation/directory-
 * snapshot.ts), NOT fetched here. Two reasons, and the second is the real one:
 *   - a list read must not fan 200 Graph requests out per page load;
 *   - getDirectoryUserByMailOrUpn returns null on ANY error, so a throttled
 *     lookup and a genuinely-empty attribute are the same blank cell. A column
 *     that cannot tell "we do not know" from "the tenant leaves it empty" is
 *     worse than no column, because an admin will conclude the latter.
 * A teammate the placement lanes have not seen yet has no snapshot and reads
 * null — the client renders that as unknown, never as empty.
 *
 * `directory_captured_at` ships WITH them, and the table renders it. A snapshot
 * whose age is not on screen is indistinguishable from live truth, and an admin
 * grouping forty people by a department captured six months ago is acting on a
 * fact the estate may no longer hold. The module claimed to be legibly stale
 * while the only column that could show it was omitted here.
 *
 * NO cost-centre column. `employeeOrgData.costCenter` is empty across this
 * estate, so a column for it would be blank for everyone and imply the data
 * exists. Department and companyName are the populated pair.
 *
 * ── THE SPEND COLUMN (C3), AND WHOSE SPEND IT IS ──────────────────────────
 * v_finance_bill_chargeback, summed per teammate over the window. That view is
 * the ANTHROPIC per-teammate chargeable bill: every GitHub/Copilot tool and lane
 * is excluded from it by construction (the mig-0085 firewall), because §B Copilot
 * money is pooled PER COST CENTRE and has no per-user figure to sum
 * (docs/design/provider-billing-attribution-model.md §B). A Copilot-only
 * teammate therefore reads $0.00 here, correctly and permanently — so `spend_usd`
 * must never be surfaced under a provider-neutral label. The client column says
 * "Claude spend"; do not generalise that wording without changing this source.
 *
 * It is still the right ranking for the worklist: it is the same money whose
 * unhomed share server/usage/unhomed-causes.ts decomposes, so "deal with the
 * biggest cluster first" orders by the figure the unhomed number is made of
 * rather than by a second definition of spend that would drift from it.
 *
 * The window defaults to the current calendar month (UTC) and is echoed back, so
 * the column can be labelled with the period it measures instead of an
 * unqualified dollar figure.
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../utils/validated-body'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { LIKE_ESCAPE, escapeLikeLiteral } from '../../../utils/sql-like'
import { HOLDING_UNIT_TYPE } from '../../../../shared/placement/holding-nodes'
import { PLACEMENT_FILTERS, type PlacementFilter } from '../../../../shared/placement/placement-filter'

const Query = z.object({
  region: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  q: z.string().max(120).optional(),
  placement: z.enum(PLACEMENT_FILTERS).default('all'),
})

interface Row extends Record<string, unknown> {
  id: string
  email: string
  display_name: string | null
  org_unit_code: string
  org_unit_display_name: string
  source: string
  is_active: boolean
  on_holding_node: boolean
  department: string | null
  company_name: string | null
  /** When the directory snapshot above was taken. NULL = never captured. */
  directory_captured_at: string | null
  /** ANTHROPIC chargeable spend in the window — see the header. */
  spend_usd: string
}

/** First instant of the current UTC month, and of the next one. */
function currentMonthWindow(now = new Date()): { startIso: string; endIso: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

/**
 * The placement predicate, as ONE expression used by both the page query and the
 * count — so a filtered page can never be reported against a differently-filtered
 * total. `all` contributes nothing rather than a tautology, so the unfiltered
 * plan is unchanged.
 */
function placementClause(placement: PlacementFilter): SQL {
  if (placement === 'unplaced') return sql`AND ou.unit_type = ${HOLDING_UNIT_TYPE}`
  if (placement === 'placed') return sql`AND ou.unit_type <> ${HOLDING_UNIT_TYPE}`
  return sql``
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const query = await getValidated(event, Query)
  await requireRegionScope(event, query.region)

  const filterClause = query.q
    ? sql`AND (t.display_name ILIKE ${`%${escapeLikeLiteral(query.q)}%`} ESCAPE ${LIKE_ESCAPE} OR t.email ILIKE ${`%${escapeLikeLiteral(query.q)}%`} ESCAPE ${LIKE_ESCAPE})`
    : sql``
  const placementFilter = placementClause(query.placement)
  const window = currentMonthWindow()

  // Rows + COUNT in ONE RLS transaction (API-13, per the admin/audit
  // house pattern "R2 F1") so the page and its total cannot disagree.
  const { rows, total, unfilteredTotal } = await withRequestRls(event, async (tx) => {
    const dataRows = await tx.execute<Row>(sql`
      SELECT t.id::text AS id,
             t.email,
             t.display_name,
             ou.code AS org_unit_code,
             ou.display_name AS org_unit_display_name,
             t.source,
             t.is_active,
             (ou.unit_type = ${HOLDING_UNIT_TYPE}) AS on_holding_node,
             t.metadata->'directory'->>'department' AS department,
             t.metadata->'directory'->>'companyName' AS company_name,
             t.metadata->'directory'->>'capturedAt' AS directory_captured_at,
             COALESCE(sp.usd, 0)::numeric(14,6)::text AS spend_usd
      FROM teammate t
      JOIN org_unit ou ON ou.id = t.org_unit_id
      LEFT JOIN LATERAL (
        SELECT SUM(b.bill_usd) AS usd
        FROM v_finance_bill_chargeback b
        WHERE b.teammate_id = t.id
          AND b.period_date >= ${window.startIso}::date
          AND b.period_date <  ${window.endIso}::date
      ) sp ON TRUE
      WHERE t.region_id = ${query.region}::uuid
        AND t.is_active = TRUE
        ${filterClause}
        ${placementFilter}
      ORDER BY t.display_name NULLS LAST, t.email
      LIMIT ${query.limit} OFFSET ${query.offset}
    `)
    /*
     * Both totals in ONE statement and ONE snapshot: "290 of 513" is a single
     * claim, and two statements could straddle a placement and print a pair that
     * never simultaneously held.
     */
    const totalRows = await tx.execute<{ total: string; unfiltered_total: string }>(sql`
      SELECT COUNT(*) FILTER (WHERE TRUE ${placementFilter})::text AS total,
             COUNT(*)::text AS unfiltered_total
      FROM teammate t
      JOIN org_unit ou ON ou.id = t.org_unit_id
      WHERE t.region_id = ${query.region}::uuid
        AND t.is_active = TRUE
        ${filterClause}
    `)
    const totals = [...totalRows][0]
    return {
      rows: [...dataRows],
      total: Number(totals?.total ?? 0),
      unfilteredTotal: Number(totals?.unfiltered_total ?? 0),
    }
  })

  return {
    teammates: rows,
    total,
    /** Ignores `placement` (but honours `q`) — the denominator in "290 of 513". */
    unfiltered_total: unfilteredTotal,
    placement: query.placement,
    spend_window: { start: window.startIso, end: window.endIso },
    limit: query.limit,
    offset: query.offset,
  }
})
