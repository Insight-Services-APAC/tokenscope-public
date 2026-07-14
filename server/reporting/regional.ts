/*
 * reporting/regional — the query layer behind the Regional reporting scope
 * (docs/design/reporting-consolidation/00-build-design.md §2/§3/§4/§5).
 *
 * ONE lane per axis (build-design §4):
 *   - usage KPIs / ranking / drivers / trend / exceptions → `v_complete_usage`
 *     (the §A completeness lane: attribution ∪ the API−OTel gap). Homed by
 *     `org_unit_id` (the point-in-time emit home) — the Regional usage axis is
 *     already point-in-time "as at emit" (owner-decisions D-Homing).
 *   - the monetised genuine-vs-chargeable pair → `v_finance_chargeback_month`
 *     (the §B bill lane), region/subtree grain.
 * No reporting query here touches `attribution_record` or raw `actual_spend`
 * (the lane firewall, build-design §7(7) — test-enforced over BOTH
 * `server/api/v1/reports/**` and `server/reporting/**`). The Copilot chargeable
 * is gated on `copilot.mode` (build-design §6 interim labelling).
 *
 * These are the SAME functions `/reports/export` calls, so the CSV is
 * byte-identical to the screen figures (build-design §2 "byte-identical rule").
 */
import { sql, type SQL } from 'drizzle-orm'
import { createError } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { managerScopePredicate, orgSubtreeScopePredicate } from '../auth/org-subtree-scope'
import { orgSubtreeIds } from '../auth/org-subtree'
import { isPlatformAdmin } from '../../shared/auth/roles'
import { csvEscape } from '../utils/csv-escape'
import { buildSeasonality, fillDowBuckets, isMonthAlignedWindow, type UsageWindow } from './params'
import { monthKeyUtc, monthRangeUtc, type MonthRangeUtc } from '../utils/period'
import type {
  DriverRow,
  DailyMetric,
  SpendClass,
  ProviderSplit,
  ActiveTrendPoint,
  SeasonalityCell,
  ChargeDailyPoint,
  ChargeDowBucket,
} from '../../shared/reports/types'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** The minimal caller shape the scope resolver needs (a resolved Session). */
export interface RegionalCaller {
  role: string
  regionId: string
}

export interface RegionRef {
  id: string
  code: string
  displayName: string
}

export interface OuRef {
  id: string
  path: string
  regionId: string
  code: string
  displayName: string
}

/** The drivers axis (build-design §2 `/reports/regional/drivers`). */
export const REGIONAL_DRIVER_AXES = ['practice', 'teammate', 'model', 'project'] as const
export type RegionalDriverAxis = (typeof REGIONAL_DRIVER_AXES)[number]

/**
 * A resolved Regional scope: the effective region, the optional `ou` drill, the
 * cross-region region list (for the selector), and the two scope-clause builders
 * (usage lane + finance lane) every query applies so they cannot diverge.
 */
export interface RegionalScope {
  effectiveRegionId: string
  region: RegionRef | null
  regionOptions: RegionRef[]
  isCrossRegion: boolean
  ou: OuRef | null
  /** Usage-lane predicate over (`region_id`, `org_unit_id`)-style columns. */
  usageScope: (regionCol: string, subtreeCol: string) => SQL
  /** Finance-lane predicate over (`region_id`, `cost_owning_unit_id`)-style columns. */
  financeScope: (regionCol: string, costOwningCol: string) => SQL
  /** `true` while dims are point-in-time "as at emit" (Regional usage lane always is). */
  pointInTimeDims: boolean
}

function forbid(detail: string): never {
  throw createError({
    statusCode: 403,
    statusMessage: 'Forbidden',
    data: {
      type: 'https://tokenscope.example.com/errors/forbidden',
      title: 'Forbidden',
      status: 403,
      detail,
    },
  })
}

/**
 * Resolve + AUTHORISE the Regional scope in-query (build-design §2 RBAC branch):
 *   - admin                          → own region FORCED (`region` param ignored)
 *   - global-finops / platform-admin → any region (validated) + the region picker
 *   - developer / manager            → their org SUBTREE, region-clamped
 *   - `ou` drill                     → the unit's subtree, gated by
 *     orgSubtreeScopePredicate OR active ownership (anti-IDOR: a foreign-region /
 *     out-of-scope unit → 403).
 */
export async function resolveRegionalScope(
  tx: Tx,
  caller: RegionalCaller,
  params: { region?: string | null; ou?: string | null },
): Promise<RegionalScope> {
  const isCrossRegion = caller.role === 'global-finops' || isPlatformAdmin(caller.role)
  const isAdmin = caller.role === 'admin'
  const isSubtree = caller.role === 'developer' || caller.role === 'manager'
  if (!isCrossRegion && !isAdmin && !isSubtree) {
    forbid(`Role '${caller.role}' is not permitted for the Regional report.`)
  }

  // Cross-region roles get the region list (selector + validation surface).
  let regionOptions: RegionRef[] = []
  if (isCrossRegion) {
    const rows = await tx.execute<{ id: string; code: string; display_name: string }>(sql`
      SELECT id::text AS id, code, display_name FROM region
      WHERE code <> '__unassigned__' ORDER BY display_name`)
    regionOptions = [...rows].map((r) => ({ id: r.id, code: r.code, displayName: r.display_name }))
  }

  // `ou` drill — resolve WITHIN scope OR active ownership (practice-page pattern).
  let ou: OuRef | null = null
  if (params.ou) {
    const ownerClause = sql`EXISTS (
      SELECT 1 FROM cou_owner co
      WHERE co.org_unit_id = org_unit.id
        AND co.teammate_id = NULLIF(current_setting('app.user_teammate_id', true), '')::uuid
        AND co.revoked_at IS NULL)`
    const rows = await tx.execute<{
      id: string
      path: string
      region_id: string
      code: string
      display_name: string
    }>(sql`
      SELECT id::text AS id, path::text AS path, region_id::text AS region_id, code, display_name
      FROM org_unit
      WHERE id = ${params.ou}::uuid AND retired_at IS NULL
        AND ( ${orgSubtreeScopePredicate('org_unit')} OR ${ownerClause} )
      LIMIT 1`)
    const r = [...rows][0]
    // Anti-IDOR: an out-of-scope / foreign-region unit simply does not resolve → 403.
    if (!r) forbid('org unit not in your scope')
    ou = {
      id: r!.id,
      path: r!.path,
      regionId: r!.region_id,
      code: r!.code,
      displayName: r!.display_name,
    }
  }

  // Effective region: the drill fixes it; else admin/subtree are hard-bound to
  // their own; cross-region honours a validated `region`, else home-or-first.
  let effectiveRegionId: string
  if (ou) {
    effectiveRegionId = ou.regionId
  } else if (isAdmin || isSubtree) {
    effectiveRegionId = caller.regionId
  } else {
    if (params.region && !regionOptions.some((o) => o.id === params.region)) {
      throw createError({ statusCode: 404, statusMessage: 'region not found' })
    }
    effectiveRegionId =
      (params.region && regionOptions.find((o) => o.id === params.region)?.id) ??
      regionOptions.find((o) => o.id === caller.regionId)?.id ??
      regionOptions[0]?.id ??
      caller.regionId
  }

  const rg = await tx.execute<{ id: string; code: string; display_name: string }>(sql`
    SELECT id::text AS id, code, display_name FROM region WHERE id = ${effectiveRegionId}::uuid LIMIT 1`)
  const rgRow = [...rg][0]
  const region: RegionRef | null = rgRow
    ? { id: rgRow.id, code: rgRow.code, displayName: rgRow.display_name }
    : null

  // developer shares the manager subtree clause (both key on the app.user_org_path
  // GUC); admin/global map to region clamps. The drill overrides with the unit's
  // own subtree (usage: all units; finance: cost-owning only).
  const scopeCaller = { role: isSubtree ? 'manager' : caller.role, regionId: caller.regionId }
  const usageScope = (regionCol: string, subtreeCol: string): SQL =>
    ou
      ? sql`${sql.raw(subtreeCol)} IN (${orgSubtreeIds(ou.path, ou.regionId)})`
      : managerScopePredicate(scopeCaller, effectiveRegionId, regionCol, subtreeCol)
  const financeScope = (regionCol: string, costOwningCol: string): SQL =>
    ou
      ? sql`${sql.raw(costOwningCol)} IN (${orgSubtreeIds(ou.path, ou.regionId, { costOwningOnly: true })})`
      : managerScopePredicate(scopeCaller, effectiveRegionId, regionCol, costOwningCol)

  return {
    effectiveRegionId,
    region,
    regionOptions,
    isCrossRegion,
    ou,
    usageScope,
    financeScope,
    pointInTimeDims: true,
  }
}

// ── KPIs ─────────────────────────────────────────────────────────────────────
export interface RegionalKpis {
  /** Usage-lane genuine total for the month (all genuine cost incl. NFR/exempt). */
  genuineUsd: number
  /** The chargeable subset (finance lane) — Anthropic only until Copilot validates. */
  chargeableUsd: number
  /** Anthropic chargeable (always included). */
  anthropicChargeableUsd: number
  /** Copilot pooled net chargeable (finance lane) — included in the total only in chargeback mode. */
  copilotChargeableUsd: number
  tokens: number
  activeUsers: number
  /**
   * Previous-CALENDAR-month chargeable total (§B finance lane) composed like
   * `chargeableUsd`; the chargeback MoM operand. 0 in range mode. Month-grained, so
   * this compares whole months (no day-of-month pacing — a usage-lane concern).
   */
  prevChargeableUsd: number
  /**
   * (chargeable − prevChargeable)/prevChargeable as a FRACTION, or null (no prior /
   * range mode). The §B analogue of the usage MoM — the two are NEVER mixed.
   */
  chargeMomDeltaPct: number | null
  /**
   * §B — distinct teammates carrying an ANTHROPIC chargeback bill over the window
   * (`v_finance_bill_chargeback`, scope-clamped). The chargeback-mode "Billed teammates"
   * tile. Anthropic-lane (per-teammate); Copilot has no per-user chargeback (pooled).
   */
  billedTeammates: number
  /** §B — Σ ANTHROPIC bill tokens over the window (`v_finance_bill_chargeback.bill_tokens`). */
  billedTokens: number
  /** §B — Anthropic chargeable ÷ billed teammates (0 when none; Anthropic-only, not Copilot). */
  avgChargePerBilledUser: number
  /**
   * §B — copilot chargeback is ON but the window is NOT month-aligned, so the pooled
   * (monthly) Copilot net is withheld from `chargeableUsd` (never a partial slice, never
   * a silent $0). The UI shows a "Copilot pooled (monthly) not shown for partial-month
   * ranges" caveat instead.
   */
  copilotPartialMonthUnavailable: boolean
  /** MAX(ts_event) in the month (`YYYY-MM-DD`), or null when the month has no data. */
  asOfDate: string | null
  /** Earliest month with data in scope (`YYYY-MM`), or null. */
  monthFloor: string | null
}

interface KpiRow extends Record<string, unknown> {
  genuine: string
  tokens: string
  active_users: number
  as_of: string | null
}
interface ChargeRow extends Record<string, unknown> {
  anthropic: string
  copilot: string
}
interface FloorRow extends Record<string, unknown> {
  floor_month: string | null
}

/**
 * The Regional KPI row: usage-lane genuine total + the finance-lane chargeable
 * pair. `copilotChargeback` decides whether the Copilot pooled net is folded
 * into `chargeableUsd` (chargeback mode) or held back with a "pending" marker
 * (pool-utilisation mode) — build-design §6.
 */
export async function fetchRegionalKpis(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
  opts: { copilotChargeback: boolean; momMonthRange?: MonthRangeUtc | null; now?: Date },
): Promise<RegionalKpis> {
  const usageScope = scope.usageScope('region_id', 'org_unit_id')
  const [totals] = [
    ...(await tx.execute<KpiRow>(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS genuine,
             COALESCE(SUM(tokens), 0)::text AS tokens,
             COUNT(DISTINCT teammate_id)::int AS active_users,
             to_char(MAX(ts_event), 'YYYY-MM-DD') AS as_of
      FROM v_complete_usage
      WHERE ${usageScope}
        AND ts_event >= ${range.startIso}::timestamptz
        AND ts_event <  ${range.endIso}::timestamptz`)),
  ]

  const [floor] = [
    ...(await tx.execute<FloorRow>(sql`
      SELECT to_char(MIN(ts_event), 'YYYY-MM') AS floor_month
      FROM v_complete_usage
      WHERE ${usageScope}`)),
  ]

  const startDate = range.startIso.slice(0, 10)
  const endDate = range.endIso.slice(0, 10)
  // §B ANTHROPIC chargeable + the per-teammate bill grain — BOTH from the DAILY bill lane
  // (`v_finance_bill_chargeback`, `period_date`-windowed, scope-clamped by the SAME finance
  // predicate). The month view's Anthropic portion is EXACTLY this view rolled to month, so
  // reading it daily is correct for ANY window — a non-month-aligned custom range no longer
  // drops the charge to $0 — and keeps the Anthropic chargeable, billed teammates + billed
  // tokens on ONE window+grain (so `avgChargePerBilledUser` divides same-day-set operands).
  // Copilot is ABSENT from this view (pooled, per-org, no per-teammate row).
  const [billed] = [
    ...(await tx.execute<{ anthropic: string; billed_teammates: number; billed_tokens: string }>(sql`
      SELECT COALESCE(SUM(bill_usd), 0)::text AS anthropic,
             COUNT(DISTINCT teammate_id)::int AS billed_teammates,
             COALESCE(SUM(bill_tokens), 0)::text AS billed_tokens
      FROM v_finance_bill_chargeback
      WHERE ${scope.financeScope('region_id', 'cost_owning_unit_id')}
        AND period_date >= ${startDate}::date AND period_date < ${endDate}::date`)),
  ]

  // §B COPILOT pooled net is POOLED-MONTHLY (`v_finance_copilot_pool_chargeback`, month
  // grain — no daily grain). Keep it month-grained (summed over every `period_month` inside
  // the window, same convention the Across bill query uses) and fold on top only in
  // chargeback mode. Scope-clamped by the SAME finance predicate.
  const [charge] = [
    ...(await tx.execute<{ copilot: string }>(sql`
      SELECT COALESCE(SUM(charge_usd), 0)::text AS copilot
      FROM v_finance_chargeback_month
      WHERE ${scope.financeScope('region_id', 'cost_owning_unit_id')}
        AND tool = 'copilot-cli'
        AND period_month >= ${startDate}::date AND period_month < ${endDate}::date`)),
  ]

  // §B chargeback MoM is computed ONLY for a fully-CLOSED calendar month. The bill lane
  // accrues intra-month, so an in-progress month is a PARTIAL MTD accrual; comparing it
  // against a WHOLE prior month understates it (a spurious decline), and month-grained
  // data CANNOT be day-paced the way the usage lane is. So the MoM is withheld (null)
  // until the viewed month closes. Range mode (no momMonthRange) is null for the same reason.
  const now = opts.now ?? new Date()
  // Closed = strictly BEFORE the current month (YYYY-MM string compare); `!==` would
  // treat a FUTURE month as closed vs the still-open current month (round-2 #5).
  const chargeMomClosed =
    opts.momMonthRange != null && opts.momMonthRange.month < monthKeyUtc(now)
  let prevChargeableAnthropic = 0
  let prevChargeableCopilot = 0
  if (chargeMomClosed) {
    const prevMonth = monthRangeUtc(
      monthKeyUtc(new Date(opts.momMonthRange!.monthStartUtc.getTime() - 1)),
    )
    const prevStart = prevMonth.startIso.slice(0, 10)
    const prevEnd = prevMonth.endIso.slice(0, 10)
    const [prevCharge] = [
      ...(await tx.execute<ChargeRow>(sql`
        SELECT COALESCE(SUM(charge_usd) FILTER (WHERE tool <> 'copilot-cli'), 0)::text AS anthropic,
               COALESCE(SUM(charge_usd) FILTER (WHERE tool = 'copilot-cli'), 0)::text  AS copilot
        FROM v_finance_chargeback_month
        WHERE ${scope.financeScope('region_id', 'cost_owning_unit_id')}
          AND period_month >= ${prevStart}::date AND period_month < ${prevEnd}::date`)),
    ]
    prevChargeableAnthropic = Number(prevCharge?.anthropic ?? 0)
    prevChargeableCopilot = Number(prevCharge?.copilot ?? 0)
  }

  // Anthropic from the DAILY bill lane (windowed); Copilot from the MONTH pool view.
  const anthropicChargeableUsd = Number(billed?.anthropic ?? 0)
  const copilotChargeableUsd = Number(charge?.copilot ?? 0)
  // The Copilot pool is POOLED-MONTHLY (no daily grain), so it may only be folded over a
  // MONTH-ALIGNED window. Over a partial-month range it is withheld (never a partial slice,
  // never a silent $0 under a "+ Copilot pooled net" label) and flagged for the UI.
  const isMonthAligned = isMonthAlignedWindow(range)
  const foldCopilot = opts.copilotChargeback && isMonthAligned
  const copilotPartialMonthUnavailable = opts.copilotChargeback && !isMonthAligned
  const chargeableUsd = anthropicChargeableUsd + (foldCopilot ? copilotChargeableUsd : 0)
  const prevChargeableUsd = prevChargeableAnthropic + (foldCopilot ? prevChargeableCopilot : 0)
  const billedTeammates = Number(billed?.billed_teammates ?? 0)
  return {
    genuineUsd: Number(totals?.genuine ?? 0),
    anthropicChargeableUsd,
    copilotChargeableUsd,
    chargeableUsd,
    tokens: Number(totals?.tokens ?? 0),
    activeUsers: Number(totals?.active_users ?? 0),
    prevChargeableUsd,
    chargeMomDeltaPct:
      prevChargeableUsd > 0 ? (chargeableUsd - prevChargeableUsd) / prevChargeableUsd : null,
    billedTeammates,
    billedTokens: Number(billed?.billed_tokens ?? 0),
    avgChargePerBilledUser: billedTeammates > 0 ? anthropicChargeableUsd / billedTeammates : 0,
    copilotPartialMonthUnavailable,
    asOfDate: totals?.as_of ?? null,
    monthFloor: floor?.floor_month ?? null,
  }
}

// ── Vendor split (drill donut) ───────────────────────────────────────────────
export interface VendorSplit {
  claudeUsd: number
  copilotUsd: number
  otherUsd: number
}

/** Usage-lane vendor split for the month in scope — feeds the `?ou=` drill donut. */
export async function fetchRegionalVendorSplit(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
): Promise<VendorSplit> {
  const [r] = [
    ...(await tx.execute<{ claude: string; copilot: string; other: string }>(sql`
      SELECT COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = 'claude-code'), 0)::text AS claude,
             COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = 'copilot-cli'), 0)::text AS copilot,
             COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool NOT IN ('claude-code', 'copilot-cli') OR u.tool IS NULL), 0)::text AS other
      FROM v_complete_usage u
      WHERE ${scope.usageScope('u.region_id', 'u.org_unit_id')}
        AND u.ts_event >= ${range.startIso}::timestamptz
        AND u.ts_event <  ${range.endIso}::timestamptz`)),
  ]
  return {
    claudeUsd: Number(r?.claude ?? 0),
    copilotUsd: Number(r?.copilot ?? 0),
    otherUsd: Number(r?.other ?? 0),
  }
}

// ── Practice ranking (top-level RankedBars) ──────────────────────────────────
export interface RankedRow {
  key: string
  label: string
  value: number
  spendClass: SpendClass
  /**
   * True when this bucket IS the region's `default` BU — the node unplaced
   * teammates land under (an unplaced-teammates signal, not a real practice).
   * A read-only display flag; touches no money math (§A usage stays §A).
   */
  isDefault: boolean
}

/**
 * Rank the region's usage by PRACTICE — the nearest cost-owning ancestor of each
 * record's emit-home unit. Records with no cost-owning ancestor bucket into an
 * explicit "Unattributed" row so the ranking SUMS BACK to the genuine headline.
 *
 * `isDefault` flags the region's `default` BU (`cou.code = 'default'`) so the
 * client can render it as a to-do ("place these teammates") rather than a peer
 * practice — a read-only boolean, no aggregation touched.
 */
export async function fetchRegionalPractices(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
): Promise<RankedRow[]> {
  const rows = await tx.execute<{
    key: string | null
    label: string | null
    value: string
    is_default: boolean | null
  }>(sql`
    SELECT cou.id::text AS key, cou.display_name AS label,
           (cou.code = 'default') AS is_default,
           COALESCE(SUM(u.cost_usd), 0)::text AS value
    FROM v_complete_usage u
    LEFT JOIN LATERAL (
      SELECT anc.id, anc.display_name, anc.code
      FROM org_unit home JOIN org_unit anc ON home.path <@ anc.path
      WHERE home.id = u.org_unit_id AND anc.is_cost_owning_unit = TRUE AND anc.retired_at IS NULL
      ORDER BY nlevel(anc.path) DESC LIMIT 1
    ) cou ON TRUE
    WHERE ${scope.usageScope('u.region_id', 'u.org_unit_id')}
      AND u.ts_event >= ${range.startIso}::timestamptz
      AND u.ts_event <  ${range.endIso}::timestamptz
    GROUP BY cou.id, cou.display_name, cou.code
    ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)
  return [...rows].map((r) => ({
    key: r.key ?? 'unattributed',
    label: r.label ?? 'Unattributed',
    value: Number(r.value),
    spendClass: 'indicative' as SpendClass,
    isDefault: r.is_default === true,
  }))
}

// ── Chargeback by cost-centre (§B finance lane — the §B analogue of practices) ─
export interface RankedChargeRow {
  key: string
  label: string
  value: number
}

/**
 * Rank the region's §B CHARGEBACK by cost-owning unit, off the bill lane — NEVER
 * `v_complete_usage`. The §B counterpart of the §A "usage by practice" ranking: usage
 * mode ranks practices off usage, chargeback mode ranks cost-centres off the real charge.
 * The NULL `cost_owning_unit_id` bucket is retained as an explicit "Unallocated" row so
 * the ranking SUMS BACK to the region chargeable headline (sum-back integrity).
 *
 * The two providers use DIFFERENT grains (the grain-mismatch fix): the Anthropic arm reads
 * the DAY-grained `v_finance_bill_chargeback` over the exact `[startDate, endDate)` window,
 * so it foots to the same windowed Anthropic total the KPI shows for ANY range. Copilot
 * pooled net is POOLED-MONTHLY (`v_finance_copilot_pool_chargeback`, no daily grain) and is
 * folded in only when `copilotChargeback` (build-design §6). Both arms are clamped by the
 * SAME finance predicate the KPI charge uses, so they can never diverge, and UNION by
 * `cost_owning_unit_id`.
 */
export async function fetchRegionalChargebackByCostCentre(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
  opts: { copilotChargeback: boolean },
): Promise<RankedChargeRow[]> {
  const startDate = range.startIso.slice(0, 10)
  const endDate = range.endIso.slice(0, 10)
  const financeScope = scope.financeScope('region_id', 'cost_owning_unit_id')
  // Copilot arm: pooled MONTHLY, folded on top only in chargeback mode (pending Wave-0
  // validation otherwise) so the ranking foots to the same chargeable the KPI shows.
  const copilotArm = opts.copilotChargeback
    ? sql`
      UNION ALL
      SELECT cost_owning_unit_id, SUM(charge_usd) AS value
      FROM v_finance_copilot_pool_chargeback
      WHERE ${financeScope}
        AND period_month >= ${startDate}::date AND period_month < ${endDate}::date
      GROUP BY cost_owning_unit_id`
    : sql``
  const rows = await tx.execute<{
    cou_id: string | null
    label: string | null
    value: string
  }>(sql`
    WITH charges AS (
      SELECT cost_owning_unit_id, SUM(bill_usd) AS value
      FROM v_finance_bill_chargeback
      WHERE ${financeScope}
        AND period_date >= ${startDate}::date AND period_date < ${endDate}::date
      GROUP BY cost_owning_unit_id
      ${copilotArm}
    )
    SELECT c.cost_owning_unit_id::text AS cou_id, cou.display_name AS label,
           COALESCE(SUM(c.value), 0)::text AS value
    FROM charges c LEFT JOIN org_unit cou ON cou.id = c.cost_owning_unit_id
    GROUP BY c.cost_owning_unit_id, cou.display_name
    ORDER BY SUM(c.value) DESC NULLS LAST`)
  return [...rows].map((r) => ({
    key: r.cou_id ?? 'unallocated',
    label: r.label ?? 'Unallocated',
    value: Number(r.value),
  }))
}

// ── Daily metrics (§A usage sparkline series, region-scoped) ──────────────────
/**
 * The region-scoped §A per-day usage series over the window (`v_complete_usage`) —
 * one row per UTC day with usage: `SUM(cost_usd)`, `SUM(tokens)`,
 * `COUNT(DISTINCT teammate_id)`, ordered by day. Feeds the KPI-tile sparklines,
 * mirroring the Across variant one tier down (scope-clamped). Pure usage lane.
 */
export async function fetchRegionalDailyMetrics(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
): Promise<DailyMetric[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  // Zero-fill EVERY calendar day in the window (generate_series LEFT JOIN the daily
  // aggregate) so a day with NO in-scope usage renders a genuine 0 — the sparkline's
  // temporal shape stays accurate instead of compressing scattered activity into
  // contiguous points. `endDate` is EXCLUSIVE, so the series stops one day before it.
  const rows = await tx.execute<{
    day: string
    genuine: string
    tokens: string
    active_users: number
  }>(sql`
    WITH days AS (
      SELECT generate_series(
               ${startDate}::timestamp,
               ${endDate}::timestamp - INTERVAL '1 day',
               INTERVAL '1 day'
             )::date AS day
    ),
    agg AS (
      SELECT date_trunc('day', u.ts_event)::date AS day,
             SUM(u.cost_usd) AS genuine,
             SUM(u.tokens) AS tokens,
             COUNT(DISTINCT u.teammate_id) AS active_users
      FROM v_complete_usage u
      WHERE ${scope.usageScope('u.region_id', 'u.org_unit_id')}
        AND u.ts_event >= ${window.startIso}::timestamptz
        AND u.ts_event <  ${window.endIso}::timestamptz
      GROUP BY 1
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
           COALESCE(a.genuine, 0)::text AS genuine,
           COALESCE(a.tokens, 0)::text AS tokens,
           COALESCE(a.active_users, 0)::int AS active_users
    FROM days d LEFT JOIN agg a ON a.day = d.day
    ORDER BY d.day`)
  return [...rows].map((r) => ({
    day: r.day,
    genuineUsd: Number(r.genuine),
    tokens: Number(r.tokens),
    activeUsers: Number(r.active_users),
  }))
}

// ── §B chargeback daily trend (bill lane — day-grained, region-scoped) ───────
/**
 * The region-scoped §B ANTHROPIC chargeback per-day series over the window
 * (`v_finance_bill_chargeback`, the per-teammate DAILY bill lane), scope-clamped by the
 * SAME finance predicate the KPI charge uses so the two can never diverge. Zero-filled
 * across the window (like the §A daily metrics). Anthropic-only (Copilot pooled/monthly).
 * The region-scoped mirror of `fetchAcrossChargebackTrend`; feeds the chargeback-mode
 * spend-trend card + the Chargeable KPI-tile sparkline. Never summed with §A usage.
 */
export async function fetchRegionalChargebackTrend(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
): Promise<ChargeDailyPoint[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const rows = await tx.execute<{ day: string; charge: string }>(sql`
    WITH days AS (
      SELECT generate_series(
               ${startDate}::timestamp,
               ${endDate}::timestamp - INTERVAL '1 day',
               INTERVAL '1 day'
             )::date AS day
    ),
    agg AS (
      SELECT period_date AS day, SUM(bill_usd) AS charge
      FROM v_finance_bill_chargeback
      WHERE ${scope.financeScope('region_id', 'cost_owning_unit_id')}
        AND period_date >= ${startDate}::date AND period_date < ${endDate}::date
      GROUP BY period_date
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(a.charge, 0)::text AS charge
    FROM days d LEFT JOIN agg a ON a.day = d.day
    ORDER BY d.day`)
  return [...rows].map((r) => ({ day: r.day, chargeUsd: Number(r.charge) }))
}

// ── §B chargeback day-of-week (bill lane — "when spend happens", region-scoped) ─
/**
 * The region-scoped §B ANTHROPIC chargeback grouped by ISO day-of-week over the window
 * (`v_finance_bill_chargeback`, `EXTRACT(ISODOW) - 1` → Mon=0..Sun=6), scope-clamped by
 * the SAME finance predicate. Always seven buckets (zero-filled). Anthropic-only. The
 * region-scoped mirror of `fetchAcrossChargebackDow`; never summed with §A usage.
 */
export async function fetchRegionalChargebackDow(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
): Promise<ChargeDowBucket[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const rows = await tx.execute<{ dow: number; charge: string }>(sql`
    SELECT (EXTRACT(ISODOW FROM period_date)::int - 1) AS dow,
           COALESCE(SUM(bill_usd), 0)::text AS charge
    FROM v_finance_bill_chargeback
    WHERE ${scope.financeScope('region_id', 'cost_owning_unit_id')}
      AND period_date >= ${startDate}::date AND period_date < ${endDate}::date
    GROUP BY 1`)
  const byDow = new Map<number, number>()
  for (const r of rows) byDow.set(Number(r.dow), Number(r.charge))
  return fillDowBuckets(byDow)
}

// ── Drivers (axis-switchable) ────────────────────────────────────────────────
/**
 * Ranked drivers for one axis, in-scope denominators, summing back to the
 * genuine headline (build-design §7(4)). The NULL bucket (unattributed model /
 * untagged project / no-practice) is always present so the sum-back holds.
 */
export async function fetchRegionalDrivers(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
  axis: RegionalDriverAxis,
): Promise<{ rows: DriverRow[]; headlineUsd: number }> {
  const usageScope = scope.usageScope('u.region_id', 'u.org_unit_id')
  const window = sql`u.ts_event >= ${range.startIso}::timestamptz AND u.ts_event < ${range.endIso}::timestamptz`

  interface Raw extends Record<string, unknown> {
    key: string | null
    label: string | null
    value: string
    pooled: boolean
  }
  let raws: Raw[]
  if (axis === 'teammate') {
    raws = [
      ...(await tx.execute<Raw>(sql`
        SELECT u.teammate_id::text AS key,
               COALESCE(t.display_name, t.email) AS label,
               COALESCE(SUM(u.cost_usd), 0)::text AS value,
               -- A teammate whose entire usage is Copilot is pooled-usage (never a
               -- per-user charge); mixed/Claude users are indicative (build-design §5).
               (COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = 'copilot-cli'), 0)
                 = COALESCE(SUM(u.cost_usd), 0) AND COALESCE(SUM(u.cost_usd), 0) > 0) AS pooled
        FROM v_complete_usage u JOIN teammate t ON t.id = u.teammate_id
        WHERE ${usageScope} AND ${window}
        GROUP BY u.teammate_id, t.display_name, t.email
        ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
    ]
  } else if (axis === 'model') {
    raws = [
      ...(await tx.execute<Raw>(sql`
        SELECT u.model AS key, u.model AS label, COALESCE(SUM(u.cost_usd), 0)::text AS value, FALSE AS pooled
        FROM v_complete_usage u
        WHERE ${usageScope} AND ${window}
        GROUP BY u.model
        ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
    ]
  } else if (axis === 'project') {
    raws = [
      ...(await tx.execute<Raw>(sql`
        SELECT p.id::text AS key, COALESCE(p.display_name, p.code) AS label,
               COALESCE(SUM(u.cost_usd), 0)::text AS value, FALSE AS pooled
        FROM v_complete_usage u LEFT JOIN project p ON p.id = u.project_id
        WHERE ${usageScope} AND ${window}
        GROUP BY p.id, p.display_name, p.code
        ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
    ]
  } else {
    // practice
    raws = [
      ...(await tx.execute<Raw>(sql`
        SELECT cou.id::text AS key, cou.display_name AS label, COALESCE(SUM(u.cost_usd), 0)::text AS value, FALSE AS pooled
        FROM v_complete_usage u
        LEFT JOIN LATERAL (
          SELECT anc.id, anc.display_name
          FROM org_unit home JOIN org_unit anc ON home.path <@ anc.path
          WHERE home.id = u.org_unit_id AND anc.is_cost_owning_unit = TRUE AND anc.retired_at IS NULL
          ORDER BY nlevel(anc.path) DESC LIMIT 1
        ) cou ON TRUE
        WHERE ${usageScope} AND ${window}
        GROUP BY cou.id, cou.display_name
        ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
    ]
  }

  const headlineUsd = raws.reduce((a, r) => a + Number(r.value), 0)
  const nullLabel =
    axis === 'model' ? 'Unattributed' : axis === 'project' ? 'Untagged' : 'Unattributed'
  const rows: DriverRow[] = raws.map((r) => {
    const usd = Number(r.value)
    return {
      key: r.key ?? `__null_${axis}`,
      label: r.label ?? nullLabel,
      usd,
      sharePct: headlineUsd > 0 ? usd / headlineUsd : 0,
      spendClass: r.pooled ? 'pooled-usage' : 'indicative',
    }
  })
  return { rows, headlineUsd }
}

// ── Trend (day grain, vendor-stacked) ────────────────────────────────────────
export interface TrendPoint {
  day: string
  key: string
  value: number
}

/** Per-day vendor split for the month (Claude / Copilot / Other), for the stacked bars. */
export async function fetchRegionalTrend(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
): Promise<{ series: TrendPoint[]; windowDays: number }> {
  const rows = await tx.execute<{ day: string; claude: string; copilot: string; other: string }>(sql`
    SELECT to_char(date_trunc('day', u.ts_event), 'YYYY-MM-DD') AS day,
           COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = 'claude-code'), 0)::text AS claude,
           COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = 'copilot-cli'), 0)::text AS copilot,
           COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool NOT IN ('claude-code', 'copilot-cli') OR u.tool IS NULL), 0)::text AS other
    FROM v_complete_usage u
    WHERE ${scope.usageScope('u.region_id', 'u.org_unit_id')}
      AND u.ts_event >= ${range.startIso}::timestamptz
      AND u.ts_event <  ${range.endIso}::timestamptz
    GROUP BY 1 ORDER BY 1`)
  const series: TrendPoint[] = []
  for (const r of rows) {
    if (Number(r.claude) > 0) series.push({ day: r.day, key: 'Claude', value: Number(r.claude) })
    if (Number(r.copilot) > 0) series.push({ day: r.day, key: 'Copilot', value: Number(r.copilot) })
    if (Number(r.other) > 0) series.push({ day: r.day, key: 'Other', value: Number(r.other) })
  }
  // Window length in days — the half-open [start, end) span. For a month window
  // this is the month length (byte-identical); for a custom range it is the span.
  const windowDays = Math.round(
    (new Date(range.endIso).getTime() - new Date(range.startIso).getTime()) / 86_400_000,
  )
  return { series, windowDays }
}

// ── Provider split (region-scoped, spend + active users) ─────────────────────
/**
 * The region-scoped per-provider split over the window (`v_complete_usage`, §A
 * usage lane): per tool bucket — `claude-code` → `claudeCode`, `copilot-cli` →
 * `copilot`, everything else (incl. NULL tool) → `other`. Mirrors the Across
 * `fetchProviderSplit` one tier down but clamped by the resolved regional scope.
 * `spendUsd` sums back to the region genuine headline; `activeUsers` is
 * `COUNT(DISTINCT teammate_id)` per bucket (NOT additive across buckets).
 */
export async function fetchRegionalProviderSplit(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
): Promise<ProviderSplit> {
  const [row] = [
    ...(await tx.execute<{
      cc_spend: string
      cc_users: number
      cp_spend: string
      cp_users: number
      ot_spend: string
      ot_users: number
    }>(sql`
      SELECT
        COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = 'claude-code'), 0)::text AS cc_spend,
        COUNT(DISTINCT u.teammate_id) FILTER (WHERE u.tool = 'claude-code')::int AS cc_users,
        COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = 'copilot-cli'), 0)::text AS cp_spend,
        COUNT(DISTINCT u.teammate_id) FILTER (WHERE u.tool = 'copilot-cli')::int AS cp_users,
        COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool NOT IN ('claude-code', 'copilot-cli') OR u.tool IS NULL), 0)::text AS ot_spend,
        COUNT(DISTINCT u.teammate_id) FILTER (WHERE u.tool NOT IN ('claude-code', 'copilot-cli') OR u.tool IS NULL)::int AS ot_users
      FROM v_complete_usage u
      WHERE ${scope.usageScope('u.region_id', 'u.org_unit_id')}
        AND u.ts_event >= ${range.startIso}::timestamptz
        AND u.ts_event <  ${range.endIso}::timestamptz`)),
  ]
  return {
    claudeCode: { spendUsd: Number(row?.cc_spend ?? 0), activeUsers: Number(row?.cc_users ?? 0) },
    copilot: { spendUsd: Number(row?.cp_spend ?? 0), activeUsers: Number(row?.cp_users ?? 0) },
    other: { spendUsd: Number(row?.ot_spend ?? 0), activeUsers: Number(row?.ot_users ?? 0) },
  }
}

// ── Seasonality (day-of-week × ISO-week heatmap, region-scoped) ───────────────
/**
 * The region-scoped day-of-week × ISO-week seasonality grid over the window
 * (`v_complete_usage`), mirroring the Across variant one tier down. Grouped by ISO
 * week × ISO dow (Mon=0..Sun=6), summing `cost_usd`; the endpoint wraps the window.
 */
export async function fetchRegionalSeasonality(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
): Promise<{ weeks: string[]; cells: SeasonalityCell[] }> {
  const rows = await tx.execute<{ iso_week: string; dow: number; value: string }>(sql`
    SELECT to_char(u.ts_event, 'IYYY-"W"IW') AS iso_week,
           (EXTRACT(ISODOW FROM u.ts_event)::int - 1) AS dow,
           COALESCE(SUM(u.cost_usd), 0)::text AS value
    FROM v_complete_usage u
    WHERE ${scope.usageScope('u.region_id', 'u.org_unit_id')}
      AND u.ts_event >= ${window.startIso}::timestamptz
      AND u.ts_event <  ${window.endIso}::timestamptz
    GROUP BY 1, 2
    ORDER BY 1, 2`)
  return buildSeasonality([...rows])
}

// ── Active-user trend (region-scoped, distinct teammates per tool per day) ────
/**
 * The region-scoped active-users-over-time series (`v_complete_usage`): per UTC
 * day, `COUNT(DISTINCT teammate_id)` for claude-code and copilot-cli. One point per
 * day with any in-scope usage; the two counts are NOT additive.
 */
export async function fetchRegionalActiveTrend(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
): Promise<ActiveTrendPoint[]> {
  const rows = await tx.execute<{ day: string; claude: number; copilot: number }>(sql`
    SELECT to_char(date_trunc('day', u.ts_event), 'YYYY-MM-DD') AS day,
           COUNT(DISTINCT u.teammate_id) FILTER (WHERE u.tool = 'claude-code')::int AS claude,
           COUNT(DISTINCT u.teammate_id) FILTER (WHERE u.tool = 'copilot-cli')::int AS copilot
    FROM v_complete_usage u
    WHERE ${scope.usageScope('u.region_id', 'u.org_unit_id')}
      AND u.ts_event >= ${window.startIso}::timestamptz
      AND u.ts_event <  ${window.endIso}::timestamptz
    GROUP BY 1 ORDER BY 1`)
  return [...rows].map((r) => ({
    day: r.day,
    claudeCode: Number(r.claude),
    copilot: Number(r.copilot),
  }))
}

// ── Exceptions (velocity-flagged, dial-driven) ───────────────────────────────
export interface RegionalException {
  teammateId: string
  name: string
  currentWeekUsd: number
  baselineMeanUsd: number
  deltaPct: number
}

/**
 * Teammates whose current-week usage spikes over their rolling 4-week mean by at
 * least the governance dial (`threshold`, a fractional delta — server/reports/
 * velocity.ts). A "now" signal (trailing weeks), NOT month-bounded. Bounded LIMIT.
 */
export async function fetchRegionalExceptions(
  tx: Tx,
  scope: RegionalScope,
  threshold: number,
  limit = 25,
): Promise<RegionalException[]> {
  const rows = await tx.execute<{
    teammate_id: string
    name: string
    current_week_usd: string
    rolling_mean_usd: string
  }>(sql`
    WITH weekly AS (
      SELECT u.teammate_id,
             date_trunc('week', u.ts_event)::date AS week_start,
             SUM(u.cost_usd) AS week_usd
      FROM v_complete_usage u
      WHERE ${scope.usageScope('u.region_id', 'u.org_unit_id')}
        AND u.ts_event >= date_trunc('week', NOW()) - INTERVAL '4 weeks'
      GROUP BY u.teammate_id, date_trunc('week', u.ts_event)
    ),
    velocity AS (
      SELECT teammate_id,
             COALESCE(SUM(week_usd) FILTER (WHERE week_start = date_trunc('week', NOW())::date), 0) AS current_week_usd,
             AVG(week_usd) FILTER (WHERE week_start < date_trunc('week', NOW())::date) AS rolling_mean_usd
      FROM weekly GROUP BY teammate_id
    )
    SELECT v.teammate_id::text AS teammate_id, COALESCE(t.display_name, t.email) AS name,
           v.current_week_usd::text AS current_week_usd,
           COALESCE(v.rolling_mean_usd, 0)::text AS rolling_mean_usd
    FROM velocity v JOIN teammate t ON t.id = v.teammate_id
    WHERE v.rolling_mean_usd IS NOT NULL AND v.rolling_mean_usd > 0
      AND (v.current_week_usd - v.rolling_mean_usd) / v.rolling_mean_usd >= ${threshold}
    ORDER BY (v.current_week_usd - v.rolling_mean_usd) / v.rolling_mean_usd DESC
    LIMIT ${limit}`)
  return [...rows].map((r) => {
    const current = Number(r.current_week_usd)
    const mean = Number(r.rolling_mean_usd)
    return {
      teammateId: r.teammate_id,
      name: r.name,
      currentWeekUsd: current,
      baselineMeanUsd: mean,
      deltaPct: mean > 0 ? (current - mean) / mean : 0,
    }
  })
}

// ── CSV serialisers (byte-identical to the JSON figures) ─────────────────────
/** `spend_usd` two-decimal, matching the on-screen `fmtUsd` precision. */
function usd(n: number): string {
  return n.toFixed(2)
}

/** Drivers CSV — one row per driver, plus a leading provenance stamp (asOf). */
export function driversToCsv(
  rows: DriverRow[],
  meta: { month: string; asOfDate: string | null; axis: string; scopeLabel: string },
): string {
  const lines = [
    `# tokenscope regional drivers · axis=${meta.axis} · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · scope=${meta.scopeLabel}`,
    'driver,spend_usd,share_pct,spend_class',
    ...rows.map(
      (r) =>
        `${csvEscape(r.label)},${usd(r.usd)},${(r.sharePct * 100).toFixed(1)},${csvEscape(r.spendClass)}`,
    ),
  ]
  return lines.join('\n') + '\n'
}

/** Trend CSV — one row per (day, vendor). */
export function trendToCsv(
  series: TrendPoint[],
  meta: { month: string; asOfDate: string | null; scopeLabel: string },
): string {
  const lines = [
    `# tokenscope regional trend · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · scope=${meta.scopeLabel}`,
    'day,vendor,spend_usd',
    ...series.map((s) => `${s.day},${csvEscape(s.key)},${usd(s.value)}`),
  ]
  return lines.join('\n') + '\n'
}

/** Practice-ranking CSV — one row per practice. */
export function practicesToCsv(
  rows: RankedRow[],
  meta: { month: string; asOfDate: string | null; scopeLabel: string },
): string {
  const lines = [
    `# tokenscope regional practices · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · scope=${meta.scopeLabel}`,
    'practice,spend_usd,spend_class',
    ...rows.map((r) => `${csvEscape(r.label)},${usd(r.value)},${csvEscape(r.spendClass)}`),
  ]
  return lines.join('\n') + '\n'
}
