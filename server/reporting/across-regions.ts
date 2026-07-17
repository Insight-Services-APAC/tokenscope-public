/*
 * reporting/across-regions — the query layer behind the Across-Regions reporting
 * scope (docs/design/reporting-consolidation/00-build-design.md §2/§3/§4/§5).
 *
 * WHOLE-OF-COMPANY. This scope has no region/ou params — it is the enterprise
 * rollup, and its ONLY audience is global-finops / platform-admin (RBAC enforced
 * in the endpoints via requireRole; there is no per-caller scope predicate to
 * apply because there is nothing to clamp — it is every region). RLS is inert at
 * runtime (see server/db/request-rls.ts), so a query with no scope clause sums
 * the entire company, exactly as intended.
 *
 * ONE lane per axis (build-design §4):
 *   - KPIs / region cards / drivers / concentration → `v_complete_usage` (the §A
 *     completeness lane: attribution ∪ the API−OTel gap), `region_id` grain.
 *   - the monetised genuine-vs-chargeable pair → `v_finance_chargeback_month`
 *     (the §B bill lane), region grain. The Copilot chargeable is gated on
 *     `copilot.mode` (build-design §6 interim labelling) — held back with a
 *     "pending" marker until Wave 0 validates on Dev.
 * No reporting query here touches `attribution_record` or raw `actual_spend`
 * (the lane firewall, build-design §7(7) — test-enforced over BOTH
 * `server/api/v1/reports/**` and `server/reporting/**`).
 *
 * These are the SAME functions `/reports/export` calls, so the CSV is
 * byte-identical to the screen figures (build-design §2 "byte-identical rule").
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { csvEscape } from '../utils/csv-escape'
import {
  laneListSql,
  chargeToVendor,
  SECTION_A_USAGE_TOOLS,
  VENDOR_LANES,
  type Vendor,
} from '../../shared/usage/vendor'
import { CLAUDE_CODE_TOOL } from '../../shared/usage/surface'
import {
  GITHUB_CHARGEABLE_LANES,
  GITHUB_FIREWALL_EXCLUSIONS,
  COPILOT_CLI_TOOL,
  COPILOT_AGENT_TOOL,
} from '../../shared/usage/github-surface'
import {
  buildSeasonality,
  fillDowBuckets,
  isMonthAlignedWindow,
  mergeWeeklyLaneRows,
  momPaceWindow,
  type UsageWindow,
} from './params'
import { monthKeyUtc, monthRangeUtc, type MonthRangeUtc } from '../utils/period'
import type {
  DriverRow,
  DailyMetric,
  ProviderSplit,
  AcrossTrendPoint,
  ActiveTrendPoint,
  SeasonalityCell,
  ChargeDailyPoint,
  ChargeLanePoint,
  ChargebackLaneRow,
  ChargeDowBucket,
  ShowbackWeeklyLaneCell,
} from '../../shared/reports/types'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/**
 * A half-open `[startIso, endIso)` usage window — re-exported from `./params`
 * (the shared definition every reporting lib binds on). `MonthRangeUtc` and the
 * resolved window are both structural supersets, so month-path callers (and
 * `/reports/export`) pass their resolved month range unchanged.
 */
export type { UsageWindow }

/** The drivers axis (build-design §2 `/reports/across-regions/drivers`). */
export const ACROSS_DRIVER_AXES = ['region', 'practice', 'teammate', 'model'] as const
export type AcrossDriverAxis = (typeof ACROSS_DRIVER_AXES)[number]

// ── KPIs (whole-company headline) ────────────────────────────────────────────
export interface AcrossKpis {
  /** Usage-lane genuine total for the month (all genuine cost incl. NFR/exempt). */
  genuineUsd: number
  /** The chargeable subset (finance lane) — Anthropic + Copilot only in chargeback mode. */
  chargeableUsd: number
  /** Anthropic chargeable (always included). */
  anthropicChargeableUsd: number
  /** Copilot pooled net chargeable (finance lane) — folded into the total only in chargeback mode. */
  copilotChargeableUsd: number
  tokens: number
  activeUsers: number
  /** Previous-month genuine total (whole company) — the MoM operand. */
  prevGenuineUsd: number
  /** (genuine − prev)/prev as a FRACTION, or null when there is no prior month. */
  momDeltaPct: number | null
  /**
   * Previous-CALENDAR-month chargeable total (§B finance lane) — the chargeback MoM
   * operand. Composed the SAME way as `chargeableUsd` (Anthropic always; Copilot
   * only in chargeback mode). 0 in range mode (no month anchor).
   */
  prevChargeableUsd: number
  /**
   * (chargeable − prevChargeable)/prevChargeable as a FRACTION, or null when there is
   * no prior month / range mode. The §B analogue of `momDeltaPct` — NEVER mixes lanes.
   * The finance lane is MONTH-grained, so this compares whole calendar months (no
   * day-of-month pacing, which only applies to the day-grained usage lane).
   */
  chargeMomDeltaPct: number | null
  /** genuine / activeUsers (0 when no active users). */
  avgPerUserUsd: number
  /**
   * §B — distinct teammates carrying an ANTHROPIC chargeback bill over the window
   * (`COUNT(DISTINCT teammate_id)` on `v_finance_bill_chargeback`, day-clipped). The
   * chargeback-mode "Billed teammates" tile. Anthropic-lane (per-teammate); Copilot
   * has no per-user chargeback (pooled).
   */
  billedTeammates: number
  /** §B — Σ ANTHROPIC bill tokens over the window (`v_finance_bill_chargeback.bill_tokens`). */
  billedTokens: number
  /**
   * §B — Anthropic chargeable ÷ billed teammates (0 when none). NOT the Copilot-inclusive
   * chargeable (Copilot is pooled, has no per-user charge), so the average is Anthropic-only.
   */
  avgChargePerBilledUser: number
  /**
   * §B — copilot chargeback is ON but the window is NOT month-aligned, so the pooled
   * (monthly) Copilot net is withheld from `chargeableUsd` (never sliced into a
   * partial-month range, never $0-faked). The UI shows a "Copilot pooled (monthly) not
   * shown for partial-month ranges" caveat instead of a bare $0.
   */
  copilotPartialMonthUnavailable: boolean
  /** MAX(ts_event) in the month (`YYYY-MM-DD`), or null when the month has no data. */
  asOfDate: string | null
  /** Earliest month with company data (`YYYY-MM`), or null. */
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

/**
 * The whole-company KPI row: usage-lane genuine total (over the window) + the
 * finance-lane chargeable pair + MoM delta + active users + avg/user.
 * `copilotChargeback` decides whether the Copilot pooled net is folded into
 * `chargeableUsd` (chargeback mode) or held back with a "pending" marker
 * (build-design §6).
 *
 * MoM is MONTH-ANCHORED: it is computed ONLY when `opts.momMonthRange` (the viewed
 * month's range, from which the as-of-paced previous-month window is derived) is
 * supplied — the month path passes it; a custom `from`/`to` range does NOT (and the
 * export path omits it), so `momDeltaPct` is `null` (an MTD delta has no
 * meaning for an arbitrary span). The finance/bill lane is month-grained
 * (`period_month` = month-start), so the charge is summed over every
 * `period_month` INSIDE the window — a single month reduces to today's one-row
 * result, and a multi-month range sums those months.
 */
export async function fetchAcrossKpis(
  tx: Tx,
  window: UsageWindow,
  opts: { copilotChargeback: boolean; momMonthRange?: MonthRangeUtc | null; now?: Date },
): Promise<AcrossKpis> {
  const [totals] = [
    ...(await tx.execute<KpiRow>(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS genuine,
             COALESCE(SUM(tokens), 0)::text AS tokens,
             COUNT(DISTINCT teammate_id)::int AS active_users,
             to_char(MAX(ts_event), 'YYYY-MM-DD') AS as_of
      FROM v_complete_usage
      WHERE ts_event >= ${window.startIso}::timestamptz
        AND ts_event <  ${window.endIso}::timestamptz`)),
  ]
  const asOfDate = totals?.as_of ?? null

  // Previous-month genuine for the MoM delta (whole company, same lane) — month
  // path only. Absent (range mode) ⇒ prevGenuineUsd stays 0 ⇒ momDeltaPct null.
  // The pace window is clipped to the DATA'S as-of day-of-month, NOT `now`: during
  // settling `as_of` lags today, so pacing on `now` would measure the current
  // month's partial data against MORE previous-month days → a spurious drop (the
  // very early-month bug the pace fix removes). No as_of (no current data) ⇒ no MoM.
  let prevGenuineUsd = 0
  if (opts.momMonthRange && asOfDate) {
    const momPrevWindow = momPaceWindow(opts.momMonthRange, new Date(`${asOfDate}T00:00:00.000Z`))
    const [prev] = [
      ...(await tx.execute<{ genuine: string }>(sql`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS genuine
        FROM v_complete_usage
        WHERE ts_event >= ${momPrevWindow.startIso}::timestamptz
          AND ts_event <  ${momPrevWindow.endIso}::timestamptz`)),
    ]
    prevGenuineUsd = Number(prev?.genuine ?? 0)
  }

  const [floor] = [
    ...(await tx.execute<{ floor_month: string | null }>(sql`
      SELECT to_char(MIN(ts_event), 'YYYY-MM') AS floor_month FROM v_complete_usage`)),
  ]

  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  // §B ANTHROPIC chargeable + the per-teammate bill grain — BOTH from the DAILY bill
  // lane (`v_finance_bill_chargeback`, `period_date`-windowed). The month view's Anthropic
  // portion is EXACTLY this view rolled to month, so reading it daily is correct for ANY
  // window — a non-month-aligned custom range no longer drops the charge to $0 (the
  // grain-mismatch bug) — and keeps the Anthropic chargeable, billed teammates + billed
  // tokens on ONE window+grain (so `avgChargePerBilledUser` divides same-day-set operands).
  // Copilot is ABSENT from this view (pooled, per-org, no per-teammate row) by construction.
  const [billed] = [
    ...(await tx.execute<{ anthropic: string; billed_teammates: number; billed_tokens: string }>(sql`
      SELECT COALESCE(SUM(bill_usd), 0)::text AS anthropic,
             COUNT(DISTINCT teammate_id)::int AS billed_teammates,
             COALESCE(SUM(bill_tokens), 0)::text AS billed_tokens
      FROM v_finance_bill_chargeback
      WHERE period_date >= ${startDate}::date AND period_date < ${endDate}::date`)),
  ]

  // §B COPILOT pooled net is POOLED-MONTHLY (`v_finance_copilot_pool_chargeback`, month
  // grain — no daily grain to window). Keep it month-grained (summed over every
  // `period_month` inside the window) and fold it on top only in chargeback mode.
  // CHARGEABLE lanes only (registry-driven, mig 0085): copilot-license + copilot-usage;
  // copilot-unclassified NEVER enters a chargeable figure (design D2).
  const [charge] = [
    ...(await tx.execute<{ copilot: string }>(sql`
      SELECT COALESCE(SUM(charge_usd), 0)::text AS copilot
      FROM v_finance_chargeback_month
      WHERE tool IN (${laneListSql(GITHUB_CHARGEABLE_LANES)})
        AND period_month >= ${startDate}::date AND period_month < ${endDate}::date`)),
  ]

  // §B chargeback MoM is computed ONLY for a fully-CLOSED calendar month. The bill lane
  // (v_finance_chargeback_month) accrues intra-month, so an in-progress month is a PARTIAL
  // MTD accrual; comparing it against a WHOLE prior month understates it (a spurious
  // decline), and month-grained data CANNOT be day-paced the way the day-grained usage
  // lane is. So the MoM is withheld (null) until the viewed month closes. Range mode
  // (no momMonthRange) is null for the same "no month anchor" reason.
  const now = opts.now ?? new Date()
  // Closed = strictly BEFORE the current month (YYYY-MM string compare). `!==` would
  // treat a FUTURE month as closed and compare it to the still-open current month
  // (partial MTD) — the exact spurious MoM this gate exists to prevent (round-2 #5).
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
    // Anthropic = everything OUTSIDE the unified GitHub firewall set (every lane id
    // + §A tool literal — never the narrower chargeback-lane list, r1 finding 1);
    // copilot = the CHARGEABLE lanes only (unclassified never charges).
    const [prevCharge] = [
      ...(await tx.execute<ChargeRow>(sql`
        SELECT COALESCE(SUM(charge_usd) FILTER (WHERE tool NOT IN (${laneListSql(GITHUB_FIREWALL_EXCLUSIONS)})), 0)::text AS anthropic,
               COALESCE(SUM(charge_usd) FILTER (WHERE tool IN (${laneListSql(GITHUB_CHARGEABLE_LANES)})), 0)::text  AS copilot
        FROM v_finance_chargeback_month
        WHERE period_month >= ${prevStart}::date AND period_month < ${prevEnd}::date`)),
    ]
    prevChargeableAnthropic = Number(prevCharge?.anthropic ?? 0)
    prevChargeableCopilot = Number(prevCharge?.copilot ?? 0)
  }

  const genuineUsd = Number(totals?.genuine ?? 0)
  const activeUsers = Number(totals?.active_users ?? 0)
  // Anthropic from the DAILY bill lane (windowed); Copilot from the MONTH pool view.
  const anthropicChargeableUsd = Number(billed?.anthropic ?? 0)
  const copilotChargeableUsd = Number(charge?.copilot ?? 0)
  // The Copilot pool is POOLED-MONTHLY (no daily grain), so it may only be folded over a
  // MONTH-ALIGNED window. Over a partial-month range it is withheld (never a partial
  // slice, never a silent $0 under a "+ Copilot pooled net" label) and flagged for the UI.
  const isMonthAligned = isMonthAlignedWindow(window)
  const foldCopilot = opts.copilotChargeback && isMonthAligned
  const copilotPartialMonthUnavailable = opts.copilotChargeback && !isMonthAligned
  const chargeableUsd = anthropicChargeableUsd + (foldCopilot ? copilotChargeableUsd : 0)
  const prevChargeableUsd = prevChargeableAnthropic + (foldCopilot ? prevChargeableCopilot : 0)
  const billedTeammates = Number(billed?.billed_teammates ?? 0)
  return {
    genuineUsd,
    anthropicChargeableUsd,
    copilotChargeableUsd,
    chargeableUsd,
    tokens: Number(totals?.tokens ?? 0),
    activeUsers,
    prevGenuineUsd,
    momDeltaPct: prevGenuineUsd > 0 ? (genuineUsd - prevGenuineUsd) / prevGenuineUsd : null,
    prevChargeableUsd,
    chargeMomDeltaPct:
      prevChargeableUsd > 0 ? (chargeableUsd - prevChargeableUsd) / prevChargeableUsd : null,
    avgPerUserUsd: activeUsers > 0 ? genuineUsd / activeUsers : 0,
    billedTeammates,
    billedTokens: Number(billed?.billed_tokens ?? 0),
    // Anthropic charge ÷ billed teammates — NOT chargeableUsd (Copilot pooled has no per-user).
    avgChargePerBilledUser: billedTeammates > 0 ? anthropicChargeableUsd / billedTeammates : 0,
    copilotPartialMonthUnavailable,
    asOfDate,
    monthFloor: floor?.floor_month ?? null,
  }
}

// ── Daily metrics (§A usage sparkline series) ────────────────────────────────
/**
 * The whole-company §A per-day usage series over the window (`v_complete_usage`) —
 * one row per UTC day with any usage: `SUM(cost_usd)`, `SUM(tokens)`,
 * `COUNT(DISTINCT teammate_id)`, ordered by day. Feeds the KPI-tile sparklines
 * (Attributed usage / Tokens / Active users / Avg usage). Pure usage lane — the
 * chargeable tile has NO daily grain (the finance lane is month-grained) and so
 * gets no sparkline (honest).
 */
export async function fetchAcrossDailyMetrics(
  tx: Tx,
  window: UsageWindow,
): Promise<DailyMetric[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  // Zero-fill EVERY calendar day in the window (generate_series LEFT JOIN the daily
  // aggregate) so a day with NO usage renders a genuine 0 — the sparkline's temporal
  // shape stays accurate instead of compressing scattered activity into contiguous
  // points. `endDate` is the EXCLUSIVE window end, so the series stops one day before it.
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
      SELECT date_trunc('day', ts_event)::date AS day,
             SUM(cost_usd) AS genuine,
             SUM(tokens) AS tokens,
             COUNT(DISTINCT teammate_id) AS active_users
      FROM v_complete_usage
      WHERE ts_event >= ${window.startIso}::timestamptz
        AND ts_event <  ${window.endIso}::timestamptz
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

// ── §B chargeback daily trend (bill lane — day-grained, whole-company) ───────
/**
 * The whole-company §B ANTHROPIC chargeback per-day series over the window
 * (`v_finance_bill_chargeback`, the per-teammate DAILY bill lane). One point per UTC
 * day, `SUM(bill_usd)`, zero-filled across the whole window (like the §A daily metrics)
 * so the trend/sparkline's temporal shape stays honest. Copilot is ABSENT by
 * construction (its chargeback is pooled, MONTH-grained — never in this view), so this
 * is a single Anthropic series; the card's caveat explains the pooled Copilot exclusion.
 * Feeds BOTH the chargeback-mode spend-trend card (rolling window) and the Chargeable
 * KPI-tile sparkline (KPI window). NEVER summed with the §A usage `cost_usd`.
 */
export async function fetchAcrossChargebackTrend(
  tx: Tx,
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
      WHERE period_date >= ${startDate}::date AND period_date < ${endDate}::date
      GROUP BY period_date
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(a.charge, 0)::text AS charge
    FROM days d LEFT JOIN agg a ON a.day = d.day
    ORDER BY d.day`)
  return [...rows].map((r) => ({ day: r.day, chargeUsd: Number(r.charge) }))
}

// ── §B chargeback lane trend (bill lane, per-lane — lane-visuals V2) ──────────
/** Canonical lane order index for deterministic per-day lane ordering. */
const LANE_ORDER = new Map<string, number>(VENDOR_LANES.map((l, i) => [l, i]))

/**
 * The per-LANE widening of {@link fetchAcrossChargebackTrend}: the SAME
 * `v_finance_bill_chargeback` window, GROUP BY tool, each tool mapped to its
 * registry lane id via `chargeToVendor` (claude-code → claude, each #142
 * non-Code surface → its own lane, unknown/NULL → other). NOT zero-filled —
 * the total `chargeSeries` stays the zero-filled axis/total of record; this
 * series carries only (day, lane) cells with rows, and Σ lanes per day equals
 * that day's `chargeUsd` cent-exactly (test-pinned). Copilot lanes are
 * structurally ABSENT (the mig-0085 firewall: §B Copilot is pooled, MONTH-
 * grained, never in this daily view). Never summed with §A usage.
 */
export async function fetchAcrossChargebackLaneTrend(
  tx: Tx,
  window: UsageWindow,
): Promise<ChargeLanePoint[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const rows = await tx.execute<{ day: string; tool: string | null; charge: string }>(sql`
    SELECT to_char(period_date, 'YYYY-MM-DD') AS day, tool, SUM(bill_usd)::text AS charge
    FROM v_finance_bill_chargeback
    WHERE period_date >= ${startDate}::date AND period_date < ${endDate}::date
    GROUP BY period_date, tool
    ORDER BY 1`)
  // Merge tools sharing a lane (e.g. nothing today, but the mapping is N:1 by
  // contract) and emit (day asc, canonical lane order) deterministically.
  const byDayLane = new Map<string, number>()
  for (const r of rows) {
    const k = `${r.day} ${chargeToVendor(r.tool)}`
    byDayLane.set(k, (byDayLane.get(k) ?? 0) + Number(r.charge))
  }
  return [...byDayLane.entries()]
    .map(([k, chargeUsd]) => {
      const [day, lane] = k.split(' ') as [string, string]
      return { day, lane, chargeUsd }
    })
    .sort(
      (a, b) =>
        (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) ||
        (LANE_ORDER.get(a.lane) ?? 99) - (LANE_ORDER.get(b.lane) ?? 99),
    )
}

// ── §B billed showback weekly lanes (bill lane — the usage-view composition hero) ─
/**
 * The whole-company BILLED showback weekly lane series over the window
 * (`v_finance_bill_showback` GROUP BY `date_trunc('week', period_date)` × tool,
 * tools mapped to registry lane ids via `toolToVendor`) — lane-visuals iter-2 I1:
 * the "Where the AI spend goes" hero + its pinned "Spend by surface · billed"
 * donut. SHOWBACK basis (every genuine dollar incl. NFR/exempt — ADR-0010 rule
 * 3), with the §A GitHub usage tools firewalled OUT (GITHUB_FIREWALL_EXCLUSIONS):
 * they are usage-basis telemetry rows riding the showback view, and a usage-basis
 * figure must never surface inside a billed-basis element. Σ cells == the
 * window's GitHub-excluded showback total, cent-exact (test-pinned). NOT
 * zero-filled (the client's week axis zero-fills); NEVER summed with §A usage.
 */
export async function fetchAcrossShowbackWeeklyLanes(
  tx: Tx,
  window: UsageWindow,
): Promise<ShowbackWeeklyLaneCell[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const rows = await tx.execute<{ week_start: string; tool: string | null; usd: string }>(sql`
    SELECT date_trunc('week', period_date)::date::text AS week_start, tool,
           COALESCE(SUM(bill_usd), 0)::text AS usd
    FROM v_finance_bill_showback
    WHERE period_date >= ${startDate}::date AND period_date < ${endDate}::date
      AND (tool NOT IN (${laneListSql(GITHUB_FIREWALL_EXCLUSIONS)}) OR tool IS NULL)
    GROUP BY 1, tool
    ORDER BY 1`)
  return mergeWeeklyLaneRows(rows)
}

// ── §B chargeback lane totals (bill lane — the split-donut operand, lane-visuals V2) ─
/**
 * Per-lane §B chargeback totals over the window — the ChargebackSplitCard donut
 * operand. Two arms, mirroring the KPI composition EXACTLY (so the donut sums
 * back to `fetchAcrossKpis.chargeableUsd` cent-exactly):
 *   - ANTHROPIC: day-grained `v_finance_bill_chargeback` GROUP BY tool over the
 *     exact window (Σ == `anthropicChargeableUsd` for ANY range), lanes via
 *     `chargeToVendor`;
 *   - COPILOT (§B lanes): pooled-monthly `v_finance_copilot_pool_chargeback`,
 *     included ONLY when `copilotChargeback` AND the window is month-aligned —
 *     the same gate as the KPI fold (never a partial-month slice, never a
 *     silent $0). ALL three lanes ride along, INCLUDING copilot-unclassified:
 *     it is VISIBLE (badged) but excluded from every chargeable sum by the UI
 *     (the FinanceCouTable convention) — Σ(lanes minus unclassified) == the
 *     chargeable headline.
 * Rows are emitted in canonical VENDOR_LANES order; zero-amount lanes with no
 * rows are omitted (UI elides zeros anyway).
 */
export async function fetchAcrossChargebackLanes(
  tx: Tx,
  window: UsageWindow,
  opts: { copilotChargeback: boolean },
): Promise<ChargebackLaneRow[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const byLane = new Map<Vendor, number>()

  const anthropicRows = await tx.execute<{ tool: string | null; charge: string }>(sql`
    SELECT tool, SUM(bill_usd)::text AS charge
    FROM v_finance_bill_chargeback
    WHERE period_date >= ${startDate}::date AND period_date < ${endDate}::date
    GROUP BY tool`)
  for (const r of anthropicRows) {
    const lane = chargeToVendor(r.tool)
    byLane.set(lane, (byLane.get(lane) ?? 0) + Number(r.charge))
  }

  // Copilot pooled lanes: month-grained, so only over a month-aligned window and
  // only once chargeback mode is validated (the KPI's exact gate).
  if (opts.copilotChargeback && isMonthAlignedWindow(window)) {
    const poolRows = await tx.execute<{ tool: string | null; charge: string }>(sql`
      SELECT tool, SUM(charge_usd)::text AS charge
      FROM v_finance_copilot_pool_chargeback
      WHERE period_month >= ${startDate}::date AND period_month < ${endDate}::date
      GROUP BY tool`)
    for (const r of poolRows) {
      const lane = chargeToVendor(r.tool)
      byLane.set(lane, (byLane.get(lane) ?? 0) + Number(r.charge))
    }
  }

  return [...byLane.entries()]
    .sort(([a], [b]) => (LANE_ORDER.get(a) ?? 99) - (LANE_ORDER.get(b) ?? 99))
    .map(([lane, chargeUsd]) => ({ lane, chargeUsd }))
}

// ── §B chargeback day-of-week (bill lane — "when spend happens", whole-company) ─
/**
 * The whole-company §B ANTHROPIC chargeback grouped by ISO day-of-week over the window
 * (`v_finance_bill_chargeback`, `EXTRACT(ISODOW) - 1` → Mon=0..Sun=6, matching the §A
 * seasonality dow convention). Always seven buckets (zero-filled) so the card renders a
 * stable Mon..Sun layout. Anthropic-only (Copilot pooled/monthly). The §B analogue of
 * the seasonality heatmap; never summed with §A usage.
 */
export async function fetchAcrossChargebackDow(
  tx: Tx,
  window: UsageWindow,
): Promise<ChargeDowBucket[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const rows = await tx.execute<{ dow: number; charge: string }>(sql`
    SELECT (EXTRACT(ISODOW FROM period_date)::int - 1) AS dow,
           COALESCE(SUM(bill_usd), 0)::text AS charge
    FROM v_finance_bill_chargeback
    WHERE period_date >= ${startDate}::date AND period_date < ${endDate}::date
    GROUP BY 1`)
  const byDow = new Map<number, number>()
  for (const r of rows) byDow.set(Number(r.dow), Number(r.charge))
  return fillDowBuckets(byDow)
}

// ── Per-region comparison cards ──────────────────────────────────────────────
export interface AcrossRegionCard {
  /** `null` for the explicit "Unassigned" bucket (usage with no region_id). */
  regionId: string | null
  code: string | null
  displayName: string
  genuineUsd: number
  anthropicChargeableUsd: number
  copilotChargeableUsd: number
  /** Anthropic + (chargeback-mode ? Copilot pooled net : 0). */
  chargeableUsd: number
  activeUsers: number
  avgPerUserUsd: number
  /** Region genuine ÷ company genuine, a FRACTION in [0,1]. */
  sharePct: number
}

/**
 * Per-region comparison cards (build-design §3 "region cards"; PRD region
 * comparison: $, %, active users, avg/user). Usage by `region_id` from
 * `v_complete_usage` merged with the finance-lane chargeable pair. The NULL
 * region_id bucket is retained as an explicit "Unassigned" card so the cards SUM
 * BACK to the genuine headline (never silently dropped).
 */
export async function fetchAcrossRegionCards(
  tx: Tx,
  window: UsageWindow,
  opts: { copilotChargeback: boolean },
): Promise<AcrossRegionCard[]> {
  const usageRows = await tx.execute<{
    region_id: string | null
    code: string | null
    display_name: string | null
    genuine: string
    active_users: number
  }>(sql`
    SELECT u.region_id::text AS region_id, r.code, r.display_name,
           COALESCE(SUM(u.cost_usd), 0)::text AS genuine,
           COUNT(DISTINCT u.teammate_id)::int AS active_users
    FROM v_complete_usage u
    LEFT JOIN region r ON r.id = u.region_id
    WHERE u.ts_event >= ${window.startIso}::timestamptz
      AND u.ts_event <  ${window.endIso}::timestamptz
    GROUP BY u.region_id, r.code, r.display_name
    ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)

  // Finance/bill lane is month-grained — sum every period_month inside the window
  // (a single month → today's one-row result; a multi-month range sums them).
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  // Registry-driven §B lane split (mig 0085): anthropic = NOT the unified GitHub
  // firewall set (every lane id + §A tool literal — a stray §A copilot row must
  // never count as Anthropic, r1 finding 1); copilot = the CHARGEABLE lanes only
  // (unclassified never charges).
  const chargeRows = await tx.execute<{
    region_id: string | null
    anthropic: string
    copilot: string
  }>(sql`
    SELECT region_id::text AS region_id,
           COALESCE(SUM(charge_usd) FILTER (WHERE tool NOT IN (${laneListSql(GITHUB_FIREWALL_EXCLUSIONS)})), 0)::text AS anthropic,
           COALESCE(SUM(charge_usd) FILTER (WHERE tool IN (${laneListSql(GITHUB_CHARGEABLE_LANES)})), 0)::text  AS copilot
    FROM v_finance_chargeback_month
    WHERE period_month >= ${startDate}::date AND period_month < ${endDate}::date
    GROUP BY region_id`)

  const chargeByRegion = new Map<string | null, { anthropic: number; copilot: number }>()
  for (const c of chargeRows) {
    chargeByRegion.set(c.region_id ?? null, {
      anthropic: Number(c.anthropic),
      copilot: Number(c.copilot),
    })
  }

  const rows = [...usageRows]
  const totalGenuine = rows.reduce((a, r) => a + Number(r.genuine), 0)
  return rows.map((r) => {
    const genuineUsd = Number(r.genuine)
    const activeUsers = Number(r.active_users)
    const charge = chargeByRegion.get(r.region_id ?? null) ?? { anthropic: 0, copilot: 0 }
    return {
      regionId: r.region_id,
      code: r.code,
      displayName: r.display_name ?? 'Unassigned',
      genuineUsd,
      anthropicChargeableUsd: charge.anthropic,
      copilotChargeableUsd: charge.copilot,
      chargeableUsd: charge.anthropic + (opts.copilotChargeback ? charge.copilot : 0),
      activeUsers,
      avgPerUserUsd: activeUsers > 0 ? genuineUsd / activeUsers : 0,
      sharePct: totalGenuine > 0 ? genuineUsd / totalGenuine : 0,
    }
  })
}

// ── Chargeback-by-region (§B bill lane — the chargeback analogue of the region cards) ─
export interface AcrossChargebackRegionRow {
  /** `null` for the explicit "Unassigned" bucket (charge with no `region_id`). */
  regionId: string | null
  label: string
  chargeableUsd: number
}

/**
 * Rank the whole-company §B CHARGEBACK by region, off the bill lane — NEVER
 * `v_complete_usage` — GROUP BY `region_id`. The chargeback-lane swap for the usage
 * region cards: because it ranks off the bill lane rather than the usage-present regions,
 * a region with §B charge but ZERO in-window usage still appears (the usage-card path
 * silently dropped it). The NULL `region_id` bucket is retained as an explicit "Unassigned"
 * row so the ranking SUMS BACK to the whole-company chargeable headline
 * (`fetchAcrossKpis.chargeableUsd`).
 *
 * The two providers use DIFFERENT grains (the grain-mismatch fix): the Anthropic arm reads
 * the DAY-grained `v_finance_bill_chargeback` over the exact `[startDate, endDate)` window,
 * so it foots to the same windowed Anthropic total the KPI shows for ANY range (a
 * non-month-aligned custom range no longer drops it). Copilot pooled net is POOLED-MONTHLY
 * (`v_finance_copilot_pool_chargeback`, no daily grain) and is folded in only when
 * `copilotChargeback` (build-design §6). The two arms UNION by `region_id`. The §A
 * counterpart of the region cards; mirrors the regional `fetchRegionalChargebackByCostCentre`.
 */
export async function fetchAcrossChargebackByRegion(
  tx: Tx,
  window: UsageWindow,
  opts: { copilotChargeback: boolean },
): Promise<AcrossChargebackRegionRow[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  // Copilot arm: pooled MONTHLY, folded on top only in chargeback mode (pending Wave-0
  // validation otherwise) so the ranking foots to the same chargeable the KPI shows.
  const copilotArm = opts.copilotChargeback
    ? sql`
      UNION ALL
      SELECT region_id, SUM(charge_usd) AS value
      FROM v_finance_copilot_pool_chargeback
      WHERE tool IN (${laneListSql(GITHUB_CHARGEABLE_LANES)})
        AND period_month >= ${startDate}::date AND period_month < ${endDate}::date
      GROUP BY region_id`
    : sql``
  const rows = await tx.execute<{
    region_id: string | null
    label: string | null
    value: string
  }>(sql`
    WITH charges AS (
      SELECT region_id, SUM(bill_usd) AS value
      FROM v_finance_bill_chargeback
      WHERE period_date >= ${startDate}::date AND period_date < ${endDate}::date
      GROUP BY region_id
      ${copilotArm}
    )
    SELECT c.region_id::text AS region_id, r.display_name AS label,
           COALESCE(SUM(c.value), 0)::text AS value
    FROM charges c LEFT JOIN region r ON r.id = c.region_id
    GROUP BY c.region_id, r.display_name
    ORDER BY SUM(c.value) DESC NULLS LAST`)
  return [...rows].map((r) => ({
    regionId: r.region_id,
    // A true NULL region_id is the "Unassigned" bucket; a non-null region_id with no
    // matching region row (FK-orphan, LEFT JOIN miss) is a DISTINCT "Unknown region"
    // — never merge the two into one "Unassigned" bar (round-2 #6).
    label: r.label ?? (r.region_id ? 'Unknown region' : 'Unassigned'),
    chargeableUsd: Number(r.value),
  }))
}

// ── Per-provider split (vendor breakdown over the window) ────────────────────
/**
 * The whole-company per-provider split over the window (`v_complete_usage`, §A
 * usage lane): one bucket per named §A lane — `claude-code` → `claudeCode`,
 * `copilot-cli` → `copilotCli`, `copilot-agent` → `copilotAgent` (the three-lane
 * §A ceiling, registry-driven via SECTION_A_USAGE_TOOLS) — plus the live `other`
 * catch-all (everything else incl. NULL tool). `spendUsd` sums back to the
 * genuine headline (every record lands in exactly one bucket); `activeUsers` is
 * `COUNT(DISTINCT teammate_id)` per bucket (NOT additive — a teammate active in
 * two vendors is counted in both). `copilot-agent` is structurally absent from
 * `v_complete_usage` today (mig 0086), so its bucket reads 0 until the owner
 * follow-up lands the non-taggable completeness feed.
 */
export async function fetchProviderSplit(tx: Tx, window: UsageWindow): Promise<ProviderSplit> {
  const [row] = [
    ...(await tx.execute<{
      cc_spend: string
      cc_users: number
      cp_spend: string
      cp_users: number
      ca_spend: string
      ca_users: number
      ot_spend: string
      ot_users: number
    }>(sql`
      SELECT
        COALESCE(SUM(cost_usd) FILTER (WHERE tool = ${CLAUDE_CODE_TOOL}), 0)::text AS cc_spend,
        COUNT(DISTINCT teammate_id) FILTER (WHERE tool = ${CLAUDE_CODE_TOOL})::int AS cc_users,
        COALESCE(SUM(cost_usd) FILTER (WHERE tool = ${COPILOT_CLI_TOOL}), 0)::text AS cp_spend,
        COUNT(DISTINCT teammate_id) FILTER (WHERE tool = ${COPILOT_CLI_TOOL})::int AS cp_users,
        COALESCE(SUM(cost_usd) FILTER (WHERE tool = ${COPILOT_AGENT_TOOL}), 0)::text AS ca_spend,
        COUNT(DISTINCT teammate_id) FILTER (WHERE tool = ${COPILOT_AGENT_TOOL})::int AS ca_users,
        COALESCE(SUM(cost_usd) FILTER (WHERE tool NOT IN (${laneListSql(SECTION_A_USAGE_TOOLS)}) OR tool IS NULL), 0)::text AS ot_spend,
        COUNT(DISTINCT teammate_id) FILTER (WHERE tool NOT IN (${laneListSql(SECTION_A_USAGE_TOOLS)}) OR tool IS NULL)::int AS ot_users
      FROM v_complete_usage
      WHERE ts_event >= ${window.startIso}::timestamptz
        AND ts_event <  ${window.endIso}::timestamptz`)),
  ]
  return {
    claudeCode: { spendUsd: Number(row?.cc_spend ?? 0), activeUsers: Number(row?.cc_users ?? 0) },
    copilotCli: { spendUsd: Number(row?.cp_spend ?? 0), activeUsers: Number(row?.cp_users ?? 0) },
    copilotAgent: { spendUsd: Number(row?.ca_spend ?? 0), activeUsers: Number(row?.ca_users ?? 0) },
    other: { spendUsd: Number(row?.ot_spend ?? 0), activeUsers: Number(row?.ot_users ?? 0) },
  }
}

// ── Trend (day grain, vendor-stacked, whole-company) ─────────────────────────
/**
 * The whole-company day-grain vendor-stacked usage trend over the window (mirrors
 * the Regional trend one tier up). One point per (day, vendor) with a positive
 * cost; `key` is the `tool` id — the three named §A lanes (`claude-code` /
 * `copilot-cli` / `copilot-agent`, registry-driven via SECTION_A_USAGE_TOOLS)
 * plus the live `other` catch-all. `copilot-agent` is structurally absent from
 * `v_complete_usage` today (mig 0086), so its points only appear once the owner
 * follow-up lands the non-taggable completeness feed.
 */
export async function fetchAcrossTrend(tx: Tx, window: UsageWindow): Promise<AcrossTrendPoint[]> {
  const rows = await tx.execute<{
    day: string
    claude: string
    copilot: string
    agent: string
    other: string
  }>(sql`
    SELECT to_char(date_trunc('day', ts_event), 'YYYY-MM-DD') AS day,
           COALESCE(SUM(cost_usd) FILTER (WHERE tool = ${CLAUDE_CODE_TOOL}), 0)::text AS claude,
           COALESCE(SUM(cost_usd) FILTER (WHERE tool = ${COPILOT_CLI_TOOL}), 0)::text AS copilot,
           COALESCE(SUM(cost_usd) FILTER (WHERE tool = ${COPILOT_AGENT_TOOL}), 0)::text AS agent,
           COALESCE(SUM(cost_usd) FILTER (WHERE tool NOT IN (${laneListSql(SECTION_A_USAGE_TOOLS)}) OR tool IS NULL), 0)::text AS other
    FROM v_complete_usage
    WHERE ts_event >= ${window.startIso}::timestamptz
      AND ts_event <  ${window.endIso}::timestamptz
    GROUP BY 1 ORDER BY 1`)
  const series: AcrossTrendPoint[] = []
  for (const r of rows) {
    if (Number(r.claude) > 0) series.push({ day: r.day, key: 'claude-code', value: Number(r.claude) })
    if (Number(r.copilot) > 0) series.push({ day: r.day, key: 'copilot-cli', value: Number(r.copilot) })
    if (Number(r.agent) > 0) series.push({ day: r.day, key: 'copilot-agent', value: Number(r.agent) })
    if (Number(r.other) > 0) series.push({ day: r.day, key: 'other', value: Number(r.other) })
  }
  return series
}

// ── Drivers (axis-switchable, whole-company) ─────────────────────────────────
/**
 * Ranked drivers for one axis over the WHOLE company, summing back to the
 * genuine headline (build-design §7(4)). The NULL bucket (unassigned region /
 * no-practice / unattributed model) is always present so the sum-back holds.
 */
export async function fetchAcrossDrivers(
  tx: Tx,
  range: UsageWindow,
  axis: AcrossDriverAxis,
): Promise<{ rows: DriverRow[]; headlineUsd: number }> {
  const window = sql`u.ts_event >= ${range.startIso}::timestamptz AND u.ts_event < ${range.endIso}::timestamptz`

  interface Raw extends Record<string, unknown> {
    key: string | null
    label: string | null
    value: string
    pooled: boolean
  }
  let raws: Raw[]
  if (axis === 'region') {
    raws = [
      ...(await tx.execute<Raw>(sql`
        SELECT u.region_id::text AS key, r.display_name AS label,
               COALESCE(SUM(u.cost_usd), 0)::text AS value, FALSE AS pooled
        FROM v_complete_usage u LEFT JOIN region r ON r.id = u.region_id
        WHERE ${window}
        GROUP BY u.region_id, r.display_name
        ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
    ]
  } else if (axis === 'teammate') {
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
        WHERE ${window}
        GROUP BY u.teammate_id, t.display_name, t.email
        ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
    ]
  } else if (axis === 'model') {
    raws = [
      ...(await tx.execute<Raw>(sql`
        SELECT u.model AS key, u.model AS label, COALESCE(SUM(u.cost_usd), 0)::text AS value, FALSE AS pooled
        FROM v_complete_usage u
        WHERE ${window}
        GROUP BY u.model
        ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
    ]
  } else {
    // practice — the nearest cost-owning ancestor of each record's emit-home unit.
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
        WHERE ${window}
        GROUP BY cou.id, cou.display_name
        ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
    ]
  }

  const headlineUsd = raws.reduce((a, r) => a + Number(r.value), 0)
  const nullLabel = axis === 'region' ? 'Unassigned' : 'Unattributed'
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

// ── Concentration + segments (build-design §5, AEUF cut-points) ───────────────
export type ConcentrationSegmentKey = 'power' | 'heavy' | 'typical' | 'light'

export interface ConcentrationSegmentStat {
  key: ConcentrationSegmentKey
  label: string
  /** Users in the segment. */
  count: number
  /** Σ cost held by the segment. */
  totalUsd: number
  /** Segment total ÷ company total, a FRACTION in [0,1]. */
  sharePct: number
  /** totalUsd ÷ count. */
  avgUsd: number
  /** The segment's median per-teammate cost. */
  medianUsd: number
}

export interface ConcentrationStats {
  activeUsers: number
  totalUsd: number
  /** Share of company spend held by the top 1% of teammates, a FRACTION in [0,1]. */
  top1: number
  /** Top 5% cohort share. */
  top5: number
  /** Top 10% cohort share. */
  top10: number
  segments: ConcentrationSegmentStat[]
}

const SEGMENT_LABELS: Record<ConcentrationSegmentKey, string> = {
  power: 'Power users',
  heavy: 'Heavy users',
  typical: 'Typical users',
  light: 'Light users',
}

/**
 * PURE concentration/segment math over a DESCENDING array of per-teammate month
 * costs (build-design §5). Concentration cohorts use `k = max(1, round(N×p))`
 * for p ∈ {0.01, 0.05, 0.10}. Segments use the AEUF cut-points — top 5% (power),
 * next 15% (heavy), middle 55% (typical), bottom 25% (light) — sized by the SAME
 * `max(1, round(N×p))` guard, with avg + median per segment. Median mirrors AEUF
 * exactly: the segment's costs sorted ASC, index `floor(len/2)`.
 */
export function computeConcentration(costsDesc: number[]): ConcentrationStats {
  const n = costsDesc.length
  const total = costsDesc.reduce((a, c) => a + c, 0)
  if (n === 0 || total <= 0) {
    return { activeUsers: n, totalUsd: total, top1: 0, top5: 0, top10: 0, segments: [] }
  }

  const topShare = (p: number): number => {
    const k = Math.max(1, Math.round(n * p))
    const s = costsDesc.slice(0, k).reduce((a, c) => a + c, 0)
    return s / total
  }

  const nPower = Math.max(1, Math.round(n * 0.05))
  const nHeavy = Math.max(1, Math.round(n * 0.15))
  const nLight = Math.max(1, Math.round(n * 0.25))
  const typicalEnd = n - nLight
  const slices: { key: ConcentrationSegmentKey; rows: number[] }[] = [
    { key: 'power', rows: costsDesc.slice(0, nPower) },
    { key: 'heavy', rows: costsDesc.slice(nPower, nPower + nHeavy) },
    { key: 'typical', rows: costsDesc.slice(nPower + nHeavy, typicalEnd) },
    { key: 'light', rows: costsDesc.slice(typicalEnd) },
  ]

  const segments: ConcentrationSegmentStat[] = slices.map((s) => {
    const count = s.rows.length
    const sum = s.rows.reduce((a, c) => a + c, 0)
    const asc = [...s.rows].sort((a, b) => a - b)
    const medianUsd = count > 0 ? asc[Math.floor(count / 2)]! : 0
    return {
      key: s.key,
      label: SEGMENT_LABELS[s.key],
      count,
      totalUsd: sum,
      sharePct: total > 0 ? sum / total : 0,
      avgUsd: count > 0 ? sum / count : 0,
      medianUsd,
    }
  })

  return {
    activeUsers: n,
    totalUsd: total,
    top1: topShare(0.01),
    top5: topShare(0.05),
    top10: topShare(0.1),
    segments,
  }
}

/**
 * Company-wide spend concentration for the month — one ranked query (per-teammate
 * month cost, DESC) fed to {@link computeConcentration}. Same usage lane as the
 * drivers, so it reconciles to the genuine headline.
 */
export async function fetchConcentration(
  tx: Tx,
  range: UsageWindow,
): Promise<ConcentrationStats> {
  const rows = await tx.execute<{ cost: string }>(sql`
    SELECT COALESCE(SUM(cost_usd), 0)::text AS cost
    FROM v_complete_usage
    WHERE ts_event >= ${range.startIso}::timestamptz
      AND ts_event <  ${range.endIso}::timestamptz
    GROUP BY teammate_id
    HAVING COALESCE(SUM(cost_usd), 0) > 0
    ORDER BY SUM(cost_usd) DESC`)
  return computeConcentration([...rows].map((r) => Number(r.cost)))
}

// ── Seasonality (day-of-week × ISO-week heatmap, whole-company) ───────────────
/**
 * The whole-company day-of-week × ISO-week seasonality grid over the window
 * (`v_complete_usage`). Grouped by ISO week (`IYYY-"W"IW`) × ISO dow (Mon=1..Sun=7,
 * emitted zero-based Mon=0..Sun=6), summing `cost_usd`. Only buckets with a usage
 * row are returned; the endpoint wraps the window echo. Session TZ is UTC (the same
 * convention the day-grain trend binds on).
 */
export async function fetchAcrossSeasonality(
  tx: Tx,
  window: UsageWindow,
): Promise<{ weeks: string[]; cells: SeasonalityCell[] }> {
  const rows = await tx.execute<{ iso_week: string; dow: number; value: string }>(sql`
    SELECT to_char(ts_event, 'IYYY-"W"IW') AS iso_week,
           (EXTRACT(ISODOW FROM ts_event)::int - 1) AS dow,
           COALESCE(SUM(cost_usd), 0)::text AS value
    FROM v_complete_usage
    WHERE ts_event >= ${window.startIso}::timestamptz
      AND ts_event <  ${window.endIso}::timestamptz
    GROUP BY 1, 2
    ORDER BY 1, 2`)
  return buildSeasonality([...rows])
}

// ── Active-user trend (distinct active teammates per tool per day) ────────────
/**
 * The whole-company active-users-over-time series (`v_complete_usage`): per UTC
 * day, `COUNT(DISTINCT teammate_id)` for claude-code and for copilot-cli. One point
 * per day with any usage; the two counts are NOT additive (a teammate active in
 * both tools counts in both).
 */
export async function fetchAcrossActiveTrend(
  tx: Tx,
  window: UsageWindow,
): Promise<ActiveTrendPoint[]> {
  const rows = await tx.execute<{ day: string; claude: number; copilot: number }>(sql`
    SELECT to_char(date_trunc('day', ts_event), 'YYYY-MM-DD') AS day,
           COUNT(DISTINCT teammate_id) FILTER (WHERE tool = 'claude-code')::int AS claude,
           COUNT(DISTINCT teammate_id) FILTER (WHERE tool = 'copilot-cli')::int AS copilot
    FROM v_complete_usage
    WHERE ts_event >= ${window.startIso}::timestamptz
      AND ts_event <  ${window.endIso}::timestamptz
    GROUP BY 1 ORDER BY 1`)
  return [...rows].map((r) => ({
    day: r.day,
    claudeCode: Number(r.claude),
    copilot: Number(r.copilot),
  }))
}

// ── CSV serialisers (byte-identical to the JSON figures) ─────────────────────
/** `spend_usd` two-decimal, matching the on-screen `fmtUsd` precision. */
function usd(n: number): string {
  return n.toFixed(2)
}

/** Drivers CSV — one row per driver, plus a leading provenance stamp (asOf). */
export function acrossDriversToCsv(
  rows: DriverRow[],
  meta: { month: string; asOfDate: string | null; axis: string },
): string {
  const lines = [
    `# tokenscope across-regions drivers · axis=${meta.axis} · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · scope=whole-company`,
    'driver,spend_usd,share_pct,spend_class',
    ...rows.map(
      (r) =>
        `${csvEscape(r.label)},${usd(r.usd)},${(r.sharePct * 100).toFixed(1)},${csvEscape(r.spendClass)}`,
    ),
  ]
  return lines.join('\n') + '\n'
}

/**
 * Region-comparison CSV — one row per region. This is a §A USAGE comparison
 * (genuine / active users / avg-per-user / share). The region card's `chargeableUsd`
 * is month-grained AND UI-dead (the screen ranks §A off `genuineUsd` and §B off the
 * DAILY-grained `chargebackByRegion`, never this figure), so it is deliberately NOT a
 * column here — a month-grained §B figure would read $0 in a sub-month range while the
 * screen KPI (now daily) is non-zero. The §B chargeback-by-region lives in its own
 * ranking (daily bill lane); it is not mixed into this usage comparison export.
 */
export function acrossRegionsToCsv(
  cards: AcrossRegionCard[],
  meta: { month: string; asOfDate: string | null },
): string {
  const lines = [
    `# tokenscope across-regions region-comparison · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · scope=whole-company`,
    'region,genuine_usd,active_users,avg_per_user_usd,share_pct',
    ...cards.map(
      (c) =>
        `${csvEscape(c.displayName)},${usd(c.genuineUsd)},${c.activeUsers},${usd(c.avgPerUserUsd)},${(c.sharePct * 100).toFixed(1)}`,
    ),
  ]
  return lines.join('\n') + '\n'
}

/** Concentration CSV — cohort shares + one row per segment (share + avg + median). */
export function concentrationToCsv(
  stats: ConcentrationStats,
  meta: { month: string; asOfDate: string | null },
): string {
  const lines = [
    `# tokenscope across-regions concentration · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · scope=whole-company · active_users=${stats.activeUsers}`,
    'cohort,share_pct',
    `Top 1%,${(stats.top1 * 100).toFixed(1)}`,
    `Top 5%,${(stats.top5 * 100).toFixed(1)}`,
    `Top 10%,${(stats.top10 * 100).toFixed(1)}`,
    '',
    'segment,users,spend_usd,share_pct,avg_usd,median_usd',
    ...stats.segments.map(
      (s) =>
        `${csvEscape(s.label)},${s.count},${usd(s.totalUsd)},${(s.sharePct * 100).toFixed(1)},${usd(s.avgUsd)},${usd(s.medianUsd)}`,
    ),
  ]
  return lines.join('\n') + '\n'
}
