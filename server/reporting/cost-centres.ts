/*
 * reporting/cost-centres — the query layer behind the Cost-Centre reporting scope
 * (docs/design/reporting-consolidation/00-build-design.md §2/§3/§4/§5, Wave 3).
 *
 * ONE lane, end to end (the §A completeness lane, `v_complete_usage`): BOTH the
 * card grid AND the drill read the PROJECT-CoU USAGE axis
 * (`v_complete_usage WHERE cost_owning_unit_id`). The tracker card shows a CC's
 * BURN; drilling it shows WHO/WHAT is burning that budget (teammate / model
 * drivers), reconciling to the SAME burn — including a spender whose CURRENT
 * placement has moved (§A homes by emit-time cost_owning_unit_id, so they never
 * vanish). Copilot pooled rows carry NULL cost_owning_unit_id, so
 * `WHERE cost_owning_unit_id = ccId` excludes them by construction (the labelled
 * §A gap) — the per-CC burn is Claude-heavy.
 *
 * The §B chargeback/billing DRILL for a cost centre (teammate-homed finance,
 * showback vs chargeable, pooled Copilot net) lives in the FINANCE scope's own CoU
 * drill — the burn DRILL here stays pure §A (it answers "who is consuming the
 * budget", not "who gets invoiced"). The card grid, however, carries a per-CC §B
 * `chargeUsd` alongside the §A burn (`fetchCostCentreCards`) so the list can re-lens
 * to the real charge in chargeback mode — read STRICTLY from the bill lane, on the
 * SAME grains the Across/Regional scopes use (grain-mismatch fix): Anthropic from the
 * DAILY per-teammate bill view (`v_finance_bill_chargeback`, `period_date`-windowed) +
 * the POOLED-MONTHLY Copilot net (`v_finance_copilot_pool_chargeback`) folded on top
 * only over a month-aligned window. NEVER summed with the §A `cost_usd` burn.
 *
 * The lane firewall (build-design §7(7), test-enforced over `server/reporting/**`)
 * bans `attribution_record` + raw `actual_spend` only: the §A burn reads
 * `v_complete_usage`; the §B `chargeUsd` reads the `v_finance_bill_chargeback` /
 * `v_finance_copilot_pool_chargeback` views (the bill lane's own surfaces, not raw
 * `actual_spend`). The two lanes are kept side-by-side but never mixed.
 *
 * These are the SAME functions `/reports/export` calls, so the CSV is
 * byte-identical to the screen figures (build-design §2 "byte-identical rule").
 */
import { sql } from 'drizzle-orm'
import { createError } from 'h3'
import type { H3Event } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { orgSubtreeScopePredicate } from '../auth/org-subtree-scope'
import { getOwnedCostCentreIds } from '../auth/org-roles'
import { requireRegionScope } from '../auth/rbac'
import { csvEscape } from '../utils/csv-escape'
import { forecastForMonth } from '../reports/forecast'
import { exhaustionDate } from '../usage/projections'
import { monthKeyUtc } from '../utils/period'
import { isMonthAlignedWindow, type UsageWindow } from './params'
import {
  costCentreBudgetState,
  type DriverRow,
  type Forecast,
  type SpendClass,
  type CostCentreSummary,
} from '../../shared/reports/types'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** The minimal caller shape the scope resolvers need (a resolved Session). */
export interface CostCentreCaller {
  role: string
  regionId: string
  teammateId: string
  orgPath: string
}

export interface CostCentreRef {
  id: string
  code: string
  displayName: string
  regionId: string
  regionCode: string
}

/**
 * The drill axis (build-design §2 `/reports/cost-centres/[ccId]`). The §A burn
 * drill ranks the burn by the human ('teammate') or the model ('model') — both
 * reconcile to the CC burn. 'project'/'vendor' are gone: project tagging + the
 * vendor invoice split are §B finance concerns (the Finance scope's CoU drill).
 */
export const COST_CENTRE_DRILL_AXES = ['teammate', 'model'] as const
export type CostCentreDrillAxis = (typeof COST_CENTRE_DRILL_AXES)[number]

// ── Scope resolution (index endpoint) ────────────────────────────────────────
/**
 * The set of cost-owning units the caller may SEE on the Cost-Centre scope
 * (build-design §2 RBAC): `getOwnedCostCentreIds` ∪ the cost-owning units in the
 * caller's org SUBTREE. Expressed as ONE in-query predicate so it stays under the
 * per-request GUCs (RLS is inert at runtime — server/db/request-rls.ts):
 *   - the subtree half reuses `orgSubtreeScopePredicate` (the tested org-tree
 *     clause: global-finops unbounded · admin own-region · dev/manager subtree)
 *     AND `is_cost_owning_unit = TRUE` — i.e. `orgSubtreeIds({costOwningOnly})`
 *     but role-aware.
 *   - the ownership half is the practice-page `ownerClause` (an active cou_owner
 *     row keyed on the `app.user_teammate_id` GUC), so a pure owner sees their
 *     owned CCs even when they sit OUTSIDE the owner's own org subtree.
 * NO region denominators are computed for pure owners (build-design §2).
 */
export async function fetchVisibleCostCentres(tx: Tx): Promise<CostCentreRef[]> {
  const ownerClause = sql`EXISTS (
    SELECT 1 FROM cou_owner co
    WHERE co.org_unit_id = ou.id
      AND co.teammate_id = NULLIF(current_setting('app.user_teammate_id', true), '')::uuid
      AND co.revoked_at IS NULL)`
  const rows = await tx.execute<{
    id: string
    code: string
    display_name: string
    region_id: string
    region_code: string
  }>(sql`
    SELECT ou.id::text AS id, ou.code, ou.display_name,
           ou.region_id::text AS region_id, r.code AS region_code
    FROM org_unit ou JOIN region r ON r.id = ou.region_id
    WHERE ou.is_cost_owning_unit = TRUE AND ou.retired_at IS NULL
      AND ( ${orgSubtreeScopePredicate('ou')} OR ${ownerClause} )
    ORDER BY r.code, ou.display_name`)
  return [...rows].map((r) => ({
    id: r.id,
    code: r.code,
    displayName: r.display_name,
    regionId: r.region_id,
    regionCode: r.region_code,
  }))
}

/**
 * Resolve + AUTHORISE a single CC for the drill endpoint (build-design §2 RBAC —
 * resource-anchored, anti-IDOR): resolve the CC's region, then grant iff the
 * caller OWNS it (any role, an active cou_owner row) OR holds region scope for
 * the CC's region (`requireRegionScope`: admin own-region · global-finops /
 * platform-admin any). A non-existent CC → 404; an existing but foreign/unowned
 * CC → 403 (so a caller cannot probe which CCs exist in a region they can't see).
 */
export async function resolveCostCentreDrill(
  tx: Tx,
  event: H3Event,
  caller: CostCentreCaller,
  ccId: string,
): Promise<CostCentreRef> {
  const rows = await tx.execute<{
    id: string
    code: string
    display_name: string
    region_id: string
    region_code: string
  }>(sql`
    SELECT ou.id::text AS id, ou.code, ou.display_name,
           ou.region_id::text AS region_id, r.code AS region_code
    FROM org_unit ou JOIN region r ON r.id = ou.region_id
    WHERE ou.id = ${ccId}::uuid AND ou.is_cost_owning_unit = TRUE AND ou.retired_at IS NULL
    LIMIT 1`)
  const cc = [...rows][0]
  if (!cc) throw createError({ statusCode: 404, statusMessage: 'cost centre not found' })

  const owned = await getOwnedCostCentreIds(tx, caller.teammateId)
  if (!owned.includes(cc.id)) {
    // requireRegionScope throws 403 for any role without scope over cc.region_id
    // (developer / manager non-owners, or an admin from another region).
    await requireRegionScope(event, cc.region_id)
  }
  return {
    id: cc.id,
    code: cc.code,
    displayName: cc.display_name,
    regionId: cc.region_id,
    regionCode: cc.region_code,
  }
}

// ── Cards (burn-vs-allocation + the two on-track mechanics) ───────────────────
export interface CostCentreCard {
  id: string
  code: string
  displayName: string
  regionCode: string
  /** PROJECT-CoU usage-axis burn for the month (Copilot NULL-CoU rows excluded). */
  burnUsd: number
  /**
   * §B CHARGEBACK for the CC over the window — the real cross-charge, homed per
   * `cost_owning_unit_id`, on the SAME grains the Across/Regional scopes use: Anthropic
   * always (DAILY bill lane `v_finance_bill_chargeback`, `period_date`-windowed — correct
   * for ANY window); the POOLED-MONTHLY Copilot net (`v_finance_copilot_pool_chargeback`)
   * folded on top only when `copilotChargeback` AND the window is month-aligned (a monthly
   * pool has no daily grain, so it is never sliced into a partial-month range). The
   * chargeback-lane figure the list shows instead of `burnUsd` in chargeback mode — a
   * SEPARATE lane, NEVER summed with the §A burn.
   */
  chargeUsd: number
  /** Σ project baseline+top-up budgets for the CC's lead projects (current effective). */
  allocationUsd: number
  /** burn / allocation as a FRACTION in [0,1], or null when no allocation. */
  utilisation: number | null
  /**
   * Mechanic 1 — BUDGET exhaustion: the DATE spend reaches the allocation at the
   * MTD burn rate, capped at month-end (projections.ts). A date, never a dollar.
   */
  exhaustionDate: string | null
  /** Mechanic 2 — RUN-RATE dollar: the metered projection (forecast.ts). null when closed. */
  forecast: Forecast | null
  asOfDate: string | null
}

export interface CostCentreCardsResult {
  cards: CostCentreCard[]
  /** MAX(ts_event) across the visible CCs in the month (`YYYY-MM-DD`), or null. */
  asOfDate: string | null
  /** Earliest month with burn in scope (`YYYY-MM`), or null. */
  monthFloor: string | null
  /**
   * §B — copilot chargeback is ON but the window is NOT month-aligned, so the pooled
   * (monthly) Copilot net is withheld from every card's `chargeUsd` (never sliced into a
   * partial-month range, never $0-faked under a "+ Copilot pooled net" label). The UI
   * surfaces a "Copilot pooled (monthly) not shown for partial-month ranges" caveat.
   */
  copilotChargebackPartialMonth: boolean
}

/**
 * Burn (project-CoU usage axis) + allocation + BOTH on-track mechanics per CC.
 *
 * `window` filters the BURN (so a custom `from`/`to` re-windows burn); ALLOCATION is
 * current-effective (`now()`), independent of the window. `monthCtx` carries the
 * month-anchored projection context: when present (the default month path) the
 * forecast (run-rate dollar) and exhaustion (budget date) are computed for the
 * in-progress month (closed months → both null); when NULL (a custom range) BOTH are
 * null — a run-rate/exhaustion projection has no meaning over an arbitrary span
 * (matching the other scopes' forecast-null-in-range-mode rule).
 */
export async function fetchCostCentreCards(
  tx: Tx,
  ccs: CostCentreRef[],
  window: UsageWindow,
  monthCtx: { month: string; now: Date } | null,
  opts: { copilotChargeback: boolean },
): Promise<CostCentreCardsResult> {
  if (ccs.length === 0)
    return {
      cards: [],
      asOfDate: null,
      monthFloor: null,
      copilotChargebackPartialMonth: opts.copilotChargeback && !isMonthAlignedWindow(window),
    }
  const ids = sql`ARRAY[${sql.join(
    ccs.map((c) => sql`${c.id}::uuid`),
    sql`, `,
  )}]`

  // Burn (project-CoU usage axis): Copilot pooled rows carry NULL cost_owning_unit_id
  // and so are EXCLUDED from `= ANY(...)` by construction (the labelled §A gap).
  const burnRows = await tx.execute<{ cc_id: string; burn: string; as_of: string | null }>(sql`
    SELECT u.cost_owning_unit_id::text AS cc_id,
           COALESCE(SUM(u.cost_usd), 0)::text AS burn,
           to_char(MAX(u.ts_event), 'YYYY-MM-DD') AS as_of
    FROM v_complete_usage u
    WHERE u.cost_owning_unit_id = ANY(${ids})
      AND u.ts_event >= ${window.startIso}::timestamptz
      AND u.ts_event <  ${window.endIso}::timestamptz
    GROUP BY u.cost_owning_unit_id`)
  const burnByCc = new Map<string, { burn: number; asOf: string | null }>()
  for (const r of burnRows) burnByCc.set(r.cc_id, { burn: Number(r.burn), asOf: r.as_of })

  // §B CHARGEBACK per CC — the SEPARATE chargeback figure the list re-lenses to, on the
  // SAME grains the Across/Regional scopes now use (grain-mismatch fix, mirrors
  // across-regions.ts / regional.ts). NEVER mixed with the §A burn above.
  //   - Anthropic: the DAILY per-teammate bill lane (`v_finance_bill_chargeback`,
  //     `period_date`-windowed) homed to each CoU. Correct for ANY window — a
  //     non-month-aligned custom range no longer drops the charge to $0 (the grain bug).
  //     Copilot is ABSENT from this view (pooled/per-org, no per-teammate row) and
  //     chargeback_exempt rows are excluded by the view.
  //   - Copilot pooled net: POOLED-MONTHLY (`v_finance_copilot_pool_chargeback`,
  //     `period_month`), folded on top ONLY when copilotChargeback AND the window is
  //     month-aligned — a monthly pool has no daily grain, so it is never sliced into a
  //     partial-month range. Withheld otherwise, and the result flags it so the UI caveats
  //     the omission instead of showing a silent $0.
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const isMonthAligned = isMonthAlignedWindow(window)
  const foldCopilot = opts.copilotChargeback && isMonthAligned

  const anthropicRows = await tx.execute<{ cc_id: string; anthropic: string }>(sql`
    SELECT cost_owning_unit_id::text AS cc_id, COALESCE(SUM(bill_usd), 0)::text AS anthropic
    FROM v_finance_bill_chargeback
    WHERE cost_owning_unit_id = ANY(${ids})
      AND period_date >= ${startDate}::date AND period_date < ${endDate}::date
    GROUP BY cost_owning_unit_id`)
  const chargeByCc = new Map<string, number>()
  for (const r of anthropicRows) chargeByCc.set(r.cc_id, Number(r.anthropic))

  if (foldCopilot) {
    const copilotRows = await tx.execute<{ cc_id: string; copilot: string }>(sql`
      SELECT cost_owning_unit_id::text AS cc_id, COALESCE(SUM(charge_usd), 0)::text AS copilot
      FROM v_finance_copilot_pool_chargeback
      WHERE cost_owning_unit_id = ANY(${ids})
        AND period_month >= ${startDate}::date AND period_month < ${endDate}::date
      GROUP BY cost_owning_unit_id`)
    for (const r of copilotRows) {
      chargeByCc.set(r.cc_id, (chargeByCc.get(r.cc_id) ?? 0) + Number(r.copilot))
    }
  }
  const copilotChargebackPartialMonth = opts.copilotChargeback && !isMonthAligned

  // Allocation: Σ current-effective baseline+top-up project budgets homed to each CC
  // (the me/cost-centres CC-level allocation mechanic, aggregated once here).
  const allocRows = await tx.execute<{ cc_id: string; alloc: string }>(sql`
    SELECT p.cost_owning_unit_id::text AS cc_id, COALESCE(SUM(a.budget_usd), 0)::text AS alloc
    FROM project p
    JOIN allocation a ON a.scope_type = 'project' AND a.scope_id = p.id
      AND a.allocation_kind IN ('baseline', 'top-up') AND a.effective @> now()
    WHERE p.cost_owning_unit_id = ANY(${ids})
    GROUP BY p.cost_owning_unit_id`)
  const allocByCc = new Map<string, number>()
  for (const r of allocRows) allocByCc.set(r.cc_id, Number(r.alloc))

  // Scope-wide floor (earliest month with burn) over the visible CCs.
  const [floor] = [
    ...(await tx.execute<{ floor_month: string | null }>(sql`
      SELECT to_char(MIN(u.ts_event), 'YYYY-MM') AS floor_month
      FROM v_complete_usage u
      WHERE u.cost_owning_unit_id = ANY(${ids})`)),
  ]

  // In range mode (monthCtx null) both month-anchored mechanics are null.
  const isCurrentMonth = monthCtx != null && monthCtx.month === monthKeyUtc(monthCtx.now)
  let scopeAsOf: string | null = null
  const cards: CostCentreCard[] = ccs.map((cc) => {
    const b = burnByCc.get(cc.id)
    const burnUsd = b?.burn ?? 0
    const asOfDate = b?.asOf ?? null
    if (asOfDate && (!scopeAsOf || asOfDate > scopeAsOf)) scopeAsOf = asOfDate
    const allocationUsd = allocByCc.get(cc.id) ?? 0

    // Mechanic 2 (run-rate dollar) — forecast.ts returns null for a closed month;
    // range mode (no month anchor) is null too.
    const asOf = asOfDate ? new Date(`${asOfDate}T00:00:00.000Z`) : null
    const forecast = monthCtx
      ? forecastForMonth({ requestedMonth: monthCtx.month, now: monthCtx.now, asOf, meteredMtdUsd: burnUsd })
      : null
    // Mechanic 1 (budget exhaustion DATE) — only meaningful on the in-progress month.
    const exhaustion = isCurrentMonth ? exhaustionDate(burnUsd, allocationUsd, monthCtx!.now) : null

    return {
      id: cc.id,
      code: cc.code,
      displayName: cc.displayName,
      regionCode: cc.regionCode,
      burnUsd,
      chargeUsd: chargeByCc.get(cc.id) ?? 0,
      allocationUsd,
      utilisation: allocationUsd > 0 ? burnUsd / allocationUsd : null,
      exhaustionDate: exhaustion,
      forecast,
      asOfDate,
    }
  })
  // Sort by burn desc so the hottest CCs lead the grid.
  cards.sort((a, b) => b.burnUsd - a.burnUsd)

  return {
    cards,
    asOfDate: scopeAsOf,
    monthFloor: floor?.floor_month ?? null,
    copilotChargebackPartialMonth,
  }
}

// ── Summary (KPI strip + RAG rollup, computed from the cards) ─────────────────
/**
 * The whole-scope Cost-Centre summary — burn/allocation totals + a RAG count
 * breakdown, computed PURELY from the visible cards (so it can never drift from the
 * grid). The four counts partition the cards exactly via the shared
 * {@link costCentreBudgetState} classifier (one RAG definition, no drift with the
 * per-card colouring the view applies).
 */
export function summariseCostCentres(
  cards: CostCentreCard[],
  asOfDate: string | null,
): CostCentreSummary {
  let totalBurnUsd = 0
  let totalAllocationUsd = 0
  let countOverBudget = 0
  let countNearBudget = 0
  let countOnTrack = 0
  let countNoAllocation = 0
  for (const c of cards) {
    totalBurnUsd += c.burnUsd
    totalAllocationUsd += c.allocationUsd
    switch (costCentreBudgetState(c.utilisation)) {
      case 'over':
        countOverBudget++
        break
      case 'warn':
        countNearBudget++
        break
      case 'ok':
        countOnTrack++
        break
      case 'none':
        countNoAllocation++
        break
    }
  }
  return {
    totalBurnUsd,
    totalAllocationUsd,
    countOverBudget,
    countNearBudget,
    countOnTrack,
    countNoAllocation,
    asOfDate,
  }
}

// ── Drill: §A USAGE BURN (project-CoU usage axis — the SAME lane as the tracker) ─
export interface CostCentreBurnDrill {
  /** Σ cost_usd over `v_complete_usage WHERE cost_owning_unit_id = ccId` in the window. */
  burnUsd: number
  /** MAX(ts_event) as `YYYY-MM-DD`, or null when the CC has no burn in the window. */
  asOf: string | null
  /** Burn split by `tool` (feeds the drill donut). Copilot pooled NULL-CoU is excluded. */
  vendor: { claudeUsd: number; copilotUsd: number; otherUsd: number }
}

/**
 * The CC's §A usage BURN for the window — IDENTICAL lane + filter to the tracker
 * card burn (`v_complete_usage WHERE cost_owning_unit_id = ccId`), so the drill
 * headline reconciles to the tracker row. Copilot pooled rows carry NULL
 * cost_owning_unit_id and are excluded by construction (the labelled §A gap), so
 * the burn is Claude-heavy; the vendor split still reports whatever `tool`s landed.
 */
export async function fetchCostCentreBurnDrill(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
): Promise<CostCentreBurnDrill> {
  const [row] = [
    ...(await tx.execute<{
      burn: string
      as_of: string | null
      claude: string
      copilot: string
      other: string
    }>(sql`
      SELECT COALESCE(SUM(u.cost_usd), 0)::text AS burn,
             to_char(MAX(u.ts_event), 'YYYY-MM-DD') AS as_of,
             COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = 'claude-code'), 0)::text AS claude,
             COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = 'copilot-cli'), 0)::text AS copilot,
             COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool NOT IN ('claude-code', 'copilot-cli') OR u.tool IS NULL), 0)::text AS other
      FROM v_complete_usage u
      WHERE u.cost_owning_unit_id = ${ccId}::uuid
        AND u.ts_event >= ${window.startIso}::timestamptz
        AND u.ts_event <  ${window.endIso}::timestamptz`)),
  ]
  return {
    burnUsd: Number(row?.burn ?? 0),
    asOf: row?.as_of ?? null,
    vendor: {
      claudeUsd: Number(row?.claude ?? 0),
      copilotUsd: Number(row?.copilot ?? 0),
      otherUsd: Number(row?.other ?? 0),
    },
  }
}

/**
 * The CC's current-effective Σ project baseline+top-up allocation (the SAME
 * allocation term `fetchCostCentreCards` sums, for a single CC) — lets the drill
 * frame the burn against its budget. 0 when the CC has no active allocation.
 */
export async function fetchCostCentreAllocation(tx: Tx, ccId: string): Promise<number> {
  const [row] = [
    ...(await tx.execute<{ alloc: string }>(sql`
      SELECT COALESCE(SUM(a.budget_usd), 0)::text AS alloc
      FROM project p
      JOIN allocation a ON a.scope_type = 'project' AND a.scope_id = p.id
        AND a.allocation_kind IN ('baseline', 'top-up') AND a.effective @> now()
      WHERE p.cost_owning_unit_id = ${ccId}::uuid`)),
  ]
  return Number(row?.alloc ?? 0)
}

// ── Drill drivers (axis-switchable §A burn drivers) ──────────────────────────
export interface CostCentreBurnDriversResult {
  rows: DriverRow[]
  /** The CC burn — what the rows sum back to (build-design §7(4)). */
  headlineUsd: number
  denominatorLabel: string
}

/**
 * Ranked §A burn drivers for one axis, summing back to the CC burn headline
 * (build-design §7(4)):
 *   - teammate → LEFT JOIN teammate for the label; EVERY §A row under a CoU carries a
 *     teammate_id, so the ranking reconciles to the burn — INCLUDING a spender
 *     whose current placement has moved (§A homes by emit-time cost_owning_unit_id).
 *     LEFT (not INNER) + COALESCE(...,'Unattributed') is defence-in-depth: an orphaned
 *     teammate_id would silently DROP a row under an inner join and break the sum-back.
 *   - model    → group by model; a NULL model → an explicit "Unattributed" bucket.
 *     DEFENSIVE only: model is NOT NULL on the §A attribution lane, so this bucket
 *     should never carry spend — it just keeps the sum-back total-safe if one ever slips.
 * Rows are `indicative` — a usage-lane $, never a per-user charge. No Copilot
 * pooled rows are present here (NULL-CoU), so there is no pooled-usage row.
 */
export async function fetchCostCentreBurnDrivers(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
  axis: CostCentreDrillAxis,
  burnUsd: number,
): Promise<CostCentreBurnDriversResult> {
  const win = sql`u.ts_event >= ${window.startIso}::timestamptz AND u.ts_event < ${window.endIso}::timestamptz`

  interface Raw extends Record<string, unknown> {
    key: string | null
    label: string | null
    value: string
  }
  let raws: Raw[]
  if (axis === 'model') {
    raws = [
      ...(await tx.execute<Raw>(sql`
        SELECT u.model AS key, u.model AS label, COALESCE(SUM(u.cost_usd), 0)::text AS value
        FROM v_complete_usage u
        WHERE u.cost_owning_unit_id = ${ccId}::uuid AND ${win}
        GROUP BY u.model
        ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
    ]
  } else {
    // teammate (default) — LEFT JOIN + COALESCE(...,'Unattributed'): an orphaned
    // teammate_id (a §A row whose teammate row is absent) would DROP under an INNER JOIN
    // and break the sum-back to the burn. Symmetric with the model axis's NULL bucket.
    raws = [
      ...(await tx.execute<Raw>(sql`
        SELECT u.teammate_id::text AS key, COALESCE(t.display_name, t.email, 'Unattributed') AS label,
               COALESCE(SUM(u.cost_usd), 0)::text AS value
        FROM v_complete_usage u LEFT JOIN teammate t ON t.id = u.teammate_id
        WHERE u.cost_owning_unit_id = ${ccId}::uuid AND ${win}
        GROUP BY u.teammate_id, t.display_name, t.email
        ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
    ]
  }

  const rows: DriverRow[] = raws.map((r) => {
    const usd = Number(r.value)
    return {
      key: r.key ?? `__null_${axis}`,
      label: r.label ?? 'Unattributed',
      usd,
      sharePct: burnUsd > 0 ? usd / burnUsd : 0,
      spendClass: 'indicative' as SpendClass,
    }
  })
  return { rows, headlineUsd: burnUsd, denominatorLabel: 'cost-centre burn' }
}

// ── CSV serialisers (byte-identical to the JSON figures) ─────────────────────
/** `spend_usd` two-decimal, matching the on-screen `fmtUsd` precision. */
function usd(n: number): string {
  return n.toFixed(2)
}

/** CC-grid CSV — one row per cost centre (burn vs allocation + both mechanics). */
export function cardsToCsv(
  cards: CostCentreCard[],
  meta: { month: string; asOfDate: string | null },
): string {
  const lines = [
    `# tokenscope cost-centres · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'}`,
    // `charge_usd` (§B chargeback, the bill lane) sits beside `burn_usd` (§A usage) and is
    // ALWAYS present regardless of the on-screen lane, so the export is complete in both.
    'cost_centre,region,burn_usd,charge_usd,allocation_usd,utilisation_pct,exhaustion_date,projected_month_end_usd',
    ...cards.map((c) =>
      [
        csvEscape(c.displayName),
        csvEscape(c.regionCode),
        usd(c.burnUsd),
        usd(c.chargeUsd),
        usd(c.allocationUsd),
        c.utilisation != null ? (c.utilisation * 100).toFixed(1) : 'n/a',
        c.exhaustionDate ?? 'n/a',
        c.forecast ? usd(c.forecast.projectedUsd) : 'n/a',
      ].join(','),
    ),
  ]
  return lines.join('\n') + '\n'
}

/** Drill drivers CSV — one row per driver (byte-identical to the DriversTable). */
export function driversToCsv(
  rows: DriverRow[],
  meta: { month: string; asOfDate: string | null; axis: string; ccLabel: string },
): string {
  const lines = [
    `# tokenscope cost-centre drivers · cc=${meta.ccLabel} · axis=${meta.axis} · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'}`,
    'driver,spend_usd,share_pct,spend_class',
    ...rows.map(
      (r) =>
        `${csvEscape(r.label)},${usd(r.usd)},${(r.sharePct * 100).toFixed(1)},${csvEscape(r.spendClass)}`,
    ),
  ]
  return lines.join('\n') + '\n'
}
